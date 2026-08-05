// Identity via Google OAuth (passport-google-oauth20). The rest of the app still
// talks to identity only through getCurrentUser(req): the OAuth handshake just
// resolves a user and stamps req.session.userId, so the session shape is unchanged
// from the previous pick-a-name sign-in and no other module needs to know about Google.
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const dbm = require('./db');

// getCurrentUser is now async (it reads the user row from Postgres).
async function getCurrentUser(req) {
  const id = req.session && req.session.userId;
  if (!id) return null;
  return dbm.getUser(id);
}

function logout(req) {
  return new Promise((resolve) => {
    if (req.session) req.session.destroy(() => resolve());
    else resolve();
  });
}

async function requireAuth(req, res, next) {
  try {
    if (!(await getCurrentUser(req))) return res.status(401).json({ error: 'Not signed in' });
    next();
  } catch (e) { next(e); }
}

// Defense-in-depth on top of Google's "Test users": if ALLOWED_EMAILS is set,
// only those addresses may sign in. Empty => rely on Google test-user gating alone.
function emailAllowed(email) {
  const raw = (process.env.ALLOWED_EMAILS || '').trim();
  if (!raw) return true;
  const target = dbm.normalizeEmail(email);
  if (!target) return false;
  // Normalize both sides so a dotted/dotless Gmail in either the allowlist or the
  // Google-supplied email still matches.
  const allow = raw.split(',').map(s => dbm.normalizeEmail(s)).filter(Boolean);
  return allow.includes(target);
}

function loginPage(req) {
  const denied = req.query && req.query.error === 'denied';
  const banner = denied
    ? `<p style="color:#c0392b;font-size:13px;margin:0 0 14px;">That Google account isn't on the invite list for Zephyr. Ask an admin to add you.</p>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in — Zephyr</title>
  <style>
    body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f4f6f5;color:#1b2b26;
      display:flex;align-items:center;justify-content:center;min-height:100vh;}
    .card{background:#fff;border:1px solid #e4e9e7;border-radius:16px;padding:2.25rem 2.5rem;width:380px;max-width:92vw;
      box-shadow:0 10px 30px -18px rgba(27,77,62,.4);text-align:center;}
    .brand{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:18px;}
    .brand span{font-size:24px;font-weight:600;}
    h1{font-size:20px;margin:0 0 6px;}
    p.sub{font-size:13px;color:#5c6b66;margin:0 0 22px;}
    a.google{display:inline-flex;align-items:center;gap:10px;background:#1b4d3e;color:#fff;text-decoration:none;
      padding:11px 20px;border-radius:10px;font-size:15px;font-weight:500;}
    a.google:hover{background:#163f33;}
  </style></head>
  <body><div class="card">
    <div class="brand">
      <svg width="34" height="34" viewBox="0 0 90 90"><rect width="90" height="90" rx="20" fill="#1b4d3e"/>
        <path d="M15,30 C35,15 45,45 75,30" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/>
        <path d="M20,45 C38,32 45,58 68,45" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/>
        <path d="M25,62 C38,52 45,72 60,62" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/></svg>
      <span>Zephyr</span>
    </div>
    <h1>Sign in to Zephyr</h1>
    <p class="sub">Task Board — shared with your team.</p>
    ${banner}
    <a class="google" href="/auth/google">
      <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#fff" d="M24 9.5c3.9 0 6.6 1.7 8.1 3.1l5.9-5.9C34.6 3.1 29.8 1 24 1 14.6 1 6.5 6.4 2.6 14.3l6.9 5.4C11.4 13.6 17.2 9.5 24 9.5z"/><path fill="#fff" d="M46.1 24.5c0-1.6-.1-2.8-.4-4.1H24v7.7h12.7c-.3 2-1.6 5-4.7 7l7.2 5.6c4.3-4 6.9-9.9 6.9-16.2z"/><path fill="#fff" d="M9.5 28.3c-.5-1.4-.8-2.9-.8-4.3s.3-3 .8-4.3l-6.9-5.4C1 17.1 0 20.4 0 24s1 6.9 2.6 9.7l6.9-5.4z"/><path fill="#fff" d="M24 47c5.8 0 10.6-1.9 14.2-5.2l-7.2-5.6c-1.9 1.3-4.5 2.3-7 2.3-6.8 0-12.6-4.1-14.5-9.7l-6.9 5.4C6.5 41.6 14.6 47 24 47z"/></svg>
      Sign in with Google
    </a>
  </div></body></html>`;
}

// Wire passport + the auth routes onto the express app. Call once at startup.
function configure(app) {
  const clientID = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const baseURL = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  const callbackURL = `${baseURL}/auth/google/callback`;

  if (!clientID || !clientSecret) {
    console.warn('[auth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — Google sign-in is disabled.');
  } else {
    passport.use(new GoogleStrategy({ clientID, clientSecret, callbackURL },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const email = profile.emails && profile.emails[0] && profile.emails[0].value;
          if (!email || !emailAllowed(email)) return done(null, false);
          let user = await dbm.getUserByEmail(email);
          if (!user) {
            user = await dbm.addUser({ name: profile.displayName || email, email });
            await dbm.syncPersonUserLinks();
            // Apply role flags now so a first-time sign-in (e.g. a manager) gets
            // their role immediately, not only after the next server restart.
            await dbm.syncAdmins();
            await dbm.syncManagers();
          }
          return done(null, user);
        } catch (e) { return done(e); }
      }));
  }
  // Handshake only — we manage the session ourselves via req.session.userId.
  app.use(passport.initialize());

  app.get('/login', (req, res) => res.type('html').send(loginPage(req)));

  app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));

  app.get('/auth/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: '/login?error=denied' }),
    (req, res) => {
      req.session.userId = req.user.id;
      res.redirect('/');
    });
}

module.exports = { configure, getCurrentUser, logout, requireAuth, emailAllowed };
