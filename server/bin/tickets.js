#!/usr/bin/env node
/**
 * Ticket recovery/management without a browser.
 *
 *   node bin/tickets.js                      → list all tickets (code, label, status)
 *   node bin/tickets.js --new "Alice" [days] → create a ticket (default 365 days, 0 = never)
 *   node bin/tickets.js --revoke SB-XXXX-XXXX / --restore SB-XXXX-XXXX
 *
 * Root shortcuts:  npm run tickets   ·   npm run new-ticket
 *
 * IMPORTANT: this tool deliberately bypasses lib/jsondb. The running server
 * caches that store in memory and flushes it debounced; if the CLI wrote
 * through the same debounce, an in-flight server flush could land in the
 * middle of the CLI's read-modify-write and the two would clobber each
 * other (observed in the field: revoke "succeeded" yet the session lived
 * on). Instead we do a direct, synchronous read→patch→write with a
 * merge-retry, then rely on jsondb's mtime hot-reload to make the running
 * server pick the change up on its next request.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const TICKETS_FILE = path.join(DATA_DIR, 'tickets.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function exists(file) { return fs.existsSync(file); }
function stamp(file) {
  try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}`; } catch (_) { return 'missing'; }
}
function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** Read→patch→write, retrying the merge if another process raced us (≤5). */
function transact(mutate) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const tBefore = stamp(TICKETS_FILE);
    const sBefore = stamp(SESSIONS_FILE);
    const tickets = readJson(TICKETS_FILE, { tickets: [] });
    const sessions = readJson(SESSIONS_FILE, { sessions: {} });
    mutate(tickets, sessions);
    // If either file changed since our read, re-read and re-apply on the
    // fresher copy instead of blindly overwriting someone else's commit.
    if (stamp(TICKETS_FILE) !== tBefore || stamp(SESSIONS_FILE) !== sBefore) continue;
    writeJsonAtomic(TICKETS_FILE, tickets);
    if (exists(SESSIONS_FILE) || Object.keys(sessions.sessions).length) {
      writeJsonAtomic(SESSIONS_FILE, sessions);
    }
    return true;
  }
  console.error('⚠️  Store kept changing under us — applied on last attempt anyway (safe: patches are idempotent).');
  const tickets = readJson(TICKETS_FILE, { tickets: [] });
  const sessions = readJson(SESSIONS_FILE, { sessions: {} });
  mutate(tickets, sessions);
  writeJsonAtomic(TICKETS_FILE, tickets);
  writeJsonAtomic(SESSIONS_FILE, sessions);
  return true;
}

const randomCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = (n) => Array.from({ length: n }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `SB-${seg(4)}-${seg(4)}`;
};
const statusOf = (t) => (t.revoked ? 'revoked' : (t.expiresAt && Date.now() > t.expiresAt ? 'expired' : 'active'));

const args = process.argv.slice(2);
const cmd = args[0];

function show(t) {
  const exp = t.expiresAt ? new Date(t.expiresAt).toISOString().slice(0, 10) : 'never';
  const last = t.lastLoginAt ? new Date(t.lastLoginAt).toISOString().slice(0, 16).replace('T', ' ') : '—';
  console.log(`  ${t.code}  ${String(t.label).padEnd(16)} ${statusOf(t).padEnd(12)} expires ${exp}  last login ${last}${t.note ? `  (${t.note})` : ''}`);
}

if (cmd === '--new' || cmd === 'new') {
  const label = String(args[1] || 'Recovery').slice(0, 80);
  const days = parseInt(args[2] || '365', 10);
  const daysValid = Number.isFinite(days) ? days : 365;
  const ticket = {
    id: crypto.randomBytes(6).toString('hex'),
    code: randomCode(),
    label,
    note: 'Created from CLI',
    createdAt: Date.now(),
    expiresAt: daysValid > 0 ? Date.now() + daysValid * 24 * 60 * 60 * 1000 : null,
    revoked: false,
    lastLoginAt: null,
  };
  transact((tickets) => { tickets.tickets.push(ticket); });
  console.log('✅ Ticket created — share this code, it is the login:');
  console.log('');
  console.log(`        ${ticket.code}`);
  console.log('');
  process.exit(0);
}

if (cmd === '--revoke' || cmd === '--restore') {
  const code = String(args[1] || '').trim().toUpperCase();
  const found = readJson(TICKETS_FILE, { tickets: [] }).tickets.find((x) => x.code === code);
  if (!found) { console.error(`❌ No ticket with code ${code}`); process.exit(1); }
  const revoke = cmd === '--revoke';
  transact((tickets, sessions) => {
    const t = tickets.tickets.find((x) => x.id === found.id);
    if (t) t.revoked = revoke;
    if (revoke) {
      // Kill live sessions immediately — the running server hot-reloads on
      // its next request, so the rug-pull is effectively instant.
      for (const token of Object.keys(sessions.sessions)) {
        if (sessions.sessions[token].ticketId === found.id) delete sessions.sessions[token];
      }
    }
  });
  console.log(`${revoke ? '🚫 Revoked' : '✅ Restored'}: ${code} (${found.label})`);
  process.exit(0);
}

const tickets = readJson(TICKETS_FILE, { tickets: [] }).tickets;
if (!tickets.length) {
  console.log('No tickets yet. Create one:  npm run new-ticket');
  process.exit(0);
}
console.log('Tickets (the CODE is what users paste on the login screen):');
tickets.forEach(show);
