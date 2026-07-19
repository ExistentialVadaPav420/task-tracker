// Phase 1 identity: session-based, no password. The whole app talks to identity
// only through getCurrentUser(req), so swapping in real SSO (Microsoft Entra ID via
// @azure/msal-node) in Phase 2 means reimplementing this module and nothing else.
// See KNOWN_LIMITATIONS.md for the impersonation caveat.
const dbm = require('./db');

function getCurrentUser(req) {
  const id = req.session && req.session.userId;
  if (!id) return null;
  return dbm.getUser(id);
}

function login(req, userId) {
  req.session.userId = userId;
}

function logout(req) {
  return new Promise((resolve) => {
    if (req.session) req.session.destroy(() => resolve());
    else resolve();
  });
}

function requireAuth(req, res, next) {
  if (!getCurrentUser(req)) return res.status(401).json({ error: 'Not signed in' });
  next();
}

module.exports = { getCurrentUser, login, logout, requireAuth };
