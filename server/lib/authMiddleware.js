/**
 * Express middleware for session tickets and the admin key.
 */
const authStore = require('./authStore');

const REASON_MESSAGES = {
  no_token: 'Sign in required.',
  no_session: 'Session not found — sign in again.',
  session_expired: 'Your session expired — sign in again.',
  revoked: 'This ticket has been discontinued by the administrator.',
  expired: 'This ticket has expired. Ask your administrator to renew it.',
  not_found: 'Session is no longer valid — sign in again.',
};

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  // <video> tags can't send headers, so streams pass the token as a query param
  return req.headers['x-session-token'] || req.query?.token || null;
}

function requireSession(req, res, next) {
  const result = authStore.validateToken(extractToken(req));
  if (!result.ok) {
    return res.status(401).json({
      error: 'unauthorized',
      reason: result.reason,
      message: REASON_MESSAGES[result.reason] || 'Unauthorized',
    });
  }
  req.user = result.user;
  req.sessionToken = extractToken(req);
  next();
}

function requireAdmin(req, res, next) {
  const adminKey = req.headers['x-admin-key'] || req.body?.adminKey || req.query.adminKey;
  const expected = process.env.ADMIN_PASSWORD || 'admin123';
  if (adminKey !== expected) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'Invalid admin key. Set ADMIN_PASSWORD on the server and use it here.',
    });
  }
  next();
}

module.exports = { requireSession, requireAdmin, extractToken };
