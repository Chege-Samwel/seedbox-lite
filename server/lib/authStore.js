/**
 * Ticket + session store.
 *
 * - Tickets are created/managed from the admin side and act as "login tickets".
 *   They can be discontinued (revoked) or renewed (expiry extended) at any time.
 * - Sessions are issued on login and validated on every API request — so a
 *   revoked/expired ticket immediately invalidates its sessions (checked at boot
 *   and on each request).
 */
const crypto = require('crypto');
const db = require('./jsondb');

const TICKETS_KEY = 'tickets';
const SESSIONS_KEY = 'sessions';

const SESSION_TTL_MS = (parseFloat(process.env.SESSION_TTL_DAYS || '7') || 7) * 24 * 60 * 60 * 1000;
const DEFAULT_TICKET_DAYS = parseFloat(process.env.DEFAULT_TICKET_DAYS || '30') || 30;

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing chars
  const seg = (n) => Array.from({ length: n }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `SB-${seg(4)}-${seg(4)}`;
}

function getTickets() {
  return db.read(TICKETS_KEY, { tickets: [] });
}

function saveTickets(data) {
  db.write(TICKETS_KEY, data);
}

function getSessions() {
  return db.read(SESSIONS_KEY, { sessions: {} });
}

function saveSessions(data) {
  db.write(SESSIONS_KEY, data);
}

function ticketStatus(ticket) {
  if (!ticket) return 'not_found';
  if (ticket.revoked) return 'revoked';
  if (ticket.expiresAt && Date.now() > ticket.expiresAt) return 'expired';
  return 'active';
}

function sanitizeTicket(t) {
  return {
    id: t.id,
    code: t.code,
    label: t.label,
    note: t.note || '',
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    revoked: !!t.revoked,
    status: ticketStatus(t),
    lastLoginAt: t.lastLoginAt || null,
  };
}

function createTicket({ label = 'Guest', note = '', daysValid = DEFAULT_TICKET_DAYS } = {}) {
  const data = getTickets();
  const ticket = {
    id: crypto.randomBytes(6).toString('hex'),
    code: randomCode(),
    label: String(label).slice(0, 80),
    note: String(note || '').slice(0, 200),
    createdAt: Date.now(),
    expiresAt: daysValid > 0 ? Date.now() + daysValid * 24 * 60 * 60 * 1000 : null,
    revoked: false,
    lastLoginAt: null,
  };
  data.tickets.push(ticket);
  saveTickets(data);
  return sanitizeTicket(ticket);
}

function listTickets() {
  return getTickets().tickets.map(sanitizeTicket);
}

function findTicket(idOrCode) {
  return getTickets().tickets.find(
    (t) => t.id === idOrCode || t.code.toLowerCase() === String(idOrCode).trim().toLowerCase()
  );
}

function patchTicket(id, patch) {
  const data = getTickets();
  const ticket = data.tickets.find((t) => t.id === id);
  if (!ticket) return null;
  if (typeof patch.revoked === 'boolean') ticket.revoked = patch.revoked;
  if (typeof patch.label === 'string') ticket.label = patch.label.slice(0, 80);
  if (typeof patch.note === 'string') ticket.note = patch.note.slice(0, 200);
  if (patch.renewDays != null) {
    const base = ticket.expiresAt && ticket.expiresAt > Date.now() ? ticket.expiresAt : Date.now();
    ticket.expiresAt = base + patch.renewDays * 24 * 60 * 60 * 1000;
    if (patch.renewDays > 0) ticket.revoked = false; // renewing re-enables
  }
  if (patch.expiresAt !== undefined) ticket.expiresAt = patch.expiresAt;
  if (ticket.revoked) {
    // Kill live sessions immediately on discontinue
    const sessions = getSessions();
    for (const token of Object.keys(sessions.sessions)) {
      if (sessions.sessions[token].ticketId === id) delete sessions.sessions[token];
    }
    saveSessions(sessions);
  }
  saveTickets(data);
  return sanitizeTicket(ticket);
}

function deleteTicket(id) {
  const data = getTickets();
  data.tickets = data.tickets.filter((t) => t.id !== id);
  saveTickets(data);
  const sessions = getSessions();
  for (const token of Object.keys(sessions.sessions)) {
    if (sessions.sessions[token].ticketId === id) delete sessions.sessions[token];
  }
  saveSessions(sessions);
  return true;
}

/**
 * Attempt login with a ticket code. Returns { ok, session?, error?, reason? }
 */
function login(code) {
  const ticket = findTicket(code);
  const status = ticketStatus(ticket);
  if (status !== 'active') {
    return { ok: false, reason: status, error: status === 'not_found'
      ? 'Invalid ticket code'
      : status === 'revoked'
        ? 'This ticket has been discontinued. Contact your administrator.'
        : 'This ticket has expired. Ask your administrator to renew it.' };
  }
  const token = crypto.randomBytes(32).toString('hex');
  const sessions = getSessions();
  sessions.sessions[token] = {
    ticketId: ticket.id,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
    lastSeenAt: Date.now(),
  };
  saveSessions(sessions);

  const data = getTickets();
  const t = data.tickets.find((x) => x.id === ticket.id);
  if (t) { t.lastLoginAt = Date.now(); saveTickets(data); }

  return {
    ok: true,
    session: {
      token,
      expiresAt: sessions.sessions[token].expiresAt,
      user: { id: ticket.id, label: ticket.label, ticketExpiresAt: ticket.expiresAt },
    },
  };
}

function logout(token) {
  const sessions = getSessions();
  delete sessions.sessions[token];
  saveSessions(sessions);
  return true;
}

/**
 * Resolve a session token → session + ticket, enforcing ticket state every time.
 */
function validateToken(token) {
  if (!token) return { ok: false, reason: 'no_token' };
  const sessions = getSessions();
  const session = sessions.sessions[token];
  if (!session) return { ok: false, reason: 'no_session' };
  if (Date.now() > session.expiresAt) {
    delete sessions.sessions[token];
    saveSessions(sessions);
    return { ok: false, reason: 'session_expired' };
  }
  const ticket = getTickets().tickets.find((t) => t.id === session.ticketId);
  const status = ticketStatus(ticket);
  if (status !== 'active') {
    delete sessions.sessions[token];
    saveSessions(sessions);
    return { ok: false, reason: status };
  }
  // Rolling renewal, throttled to avoid write amplification
  if (Date.now() - (session.lastSeenAt || 0) > 5 * 60 * 1000) {
    session.lastSeenAt = Date.now();
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    saveSessions(sessions);
  }
  return {
    ok: true,
    session,
    user: { id: ticket.id, label: ticket.label, ticketExpiresAt: ticket.expiresAt },
  };
}

/** First-boot seeding: make sure at least one ticket exists and log it loudly. */
function bootstrap() {
  const data = getTickets();
  if (data.tickets.length === 0) {
    const owner = createTicket({ label: 'Owner', note: 'Created automatically on first boot', daysValid: 365 });
    console.log('');
    console.log('════════════════════════════════════════════════════════');
    console.log('🎟️  FIRST BOOT — OWNER LOGIN TICKET CREATED');
    console.log(`🎟️  Ticket code: ${owner.code}`);
    console.log('🎟️  Use this code to log in. Manage tickets in /admin.');
    console.log('════════════════════════════════════════════════════════');
    console.log('');
  } else {
    // Codes are secrets — they're printed ONCE (first boot), never again.
    // But say so out loud, or a production deploy looks "broken" for not
    // printing anything, with no visible recovery path.
    const active = data.tickets.filter((t) => ticketStatus(t) === 'active').length;
    console.log(`🎟️  ${active}/${data.tickets.length} ticket(s) active — codes printed only on FIRST boot for safety.`);
    console.log('🎟️  Lost the code?  list: npm run tickets   ·   create: npm run new-ticket   ·   manage: /admin (admin key = ADMIN_PASSWORD env)');
  }
}

module.exports = {
  bootstrap,
  login,
  logout,
  validateToken,
  createTicket,
  listTickets,
  findTicket,
  patchTicket,
  deleteTicket,
  ticketStatus,
};
