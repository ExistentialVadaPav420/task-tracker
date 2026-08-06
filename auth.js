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
    ? `<div class="denied">That Google account isn't on the invite list for Zephyr. Ask an admin to add you.</div>`
    : '';
  const gsvg = `<svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true"><path fill="#fff" d="M24 9.5c3.9 0 6.6 1.7 8.1 3.1l5.9-5.9C34.6 3.1 29.8 1 24 1 14.6 1 6.5 6.4 2.6 14.3l6.9 5.4C11.4 13.6 17.2 9.5 24 9.5z"/><path fill="#fff" d="M46.1 24.5c0-1.6-.1-2.8-.4-4.1H24v7.7h12.7c-.3 2-1.6 5-4.7 7l7.2 5.6c4.3-4 6.9-9.9 6.9-16.2z"/><path fill="#fff" d="M9.5 28.3c-.5-1.4-.8-2.9-.8-4.3s.3-3 .8-4.3l-6.9-5.4C1 17.1 0 20.4 0 24s1 6.9 2.6 9.7l6.9-5.4z"/><path fill="#fff" d="M24 47c5.8 0 10.6-1.9 14.2-5.2l-7.2-5.6c-1.9 1.3-4.5 2.3-7 2.3-6.8 0-12.6-4.1-14.5-9.7l-6.9 5.4C6.5 41.6 14.6 47 24 47z"/></svg>`;
  const gbtn = `<a class="gbtn" href="/auth/google">${gsvg} Sign in with Google</a>`;
  const logo = `<span class="logo"><svg width="28" height="28" viewBox="0 0 90 90"><rect width="90" height="90" rx="20" fill="#1b4332"/><path d="M15,30 C35,15 45,45 75,30" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/><path d="M20,45 C38,32 45,58 68,45" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/><path d="M25,62 C38,52 45,72 60,62" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/></svg><b>Zephyr</b></span>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Zephyr — Dependency Tracking</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400..700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500&family=Material+Symbols+Outlined:opsz,wght,FILL@24,400,0&display=swap">
  <style>
   :root{--paper:#f7f6f1;--card:#fff;--ink:#1b1c1a;--soft:#5d5f57;--line:#e4e2da;--primary:#1b4332;--teal:#1b4d3e;--amber:#c98a3c;--coral:#ba1a1a;}
   *{box-sizing:border-box;}
   body{margin:0;background:var(--paper);color:var(--ink);font-family:'Inter',system-ui,sans-serif;-webkit-font-smoothing:antialiased;}
   .material-symbols-outlined{font-family:'Material Symbols Outlined';line-height:1;vertical-align:middle;}
   .wrap{max-width:1000px;margin:0 auto;padding:0 24px;}
   header{display:flex;justify-content:space-between;align-items:center;padding:20px 0;}
   .logo{display:inline-flex;align-items:center;gap:9px;} .logo b{font-family:'Source Serif 4',serif;font-size:20px;font-weight:600;}
   .gbtn{display:inline-flex;align-items:center;gap:9px;background:var(--primary);color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-size:14px;font-weight:500;transition:opacity .15s;}
   .gbtn:hover{opacity:.9;}
   .hero{text-align:center;padding:44px 0 4px;}
   .hero h1{font-family:'Source Serif 4',serif;font-size:44px;line-height:1.12;font-weight:600;letter-spacing:-.02em;margin:0 auto;max-width:640px;}
   .hero p{color:var(--soft);font-size:17px;margin:16px auto 0;max-width:520px;}
   .denied{max-width:520px;margin:18px auto 0;background:#f6e5e2;color:var(--coral);border:1px solid #e6c4bf;border-radius:10px;padding:10px 14px;font-size:13.5px;text-align:center;}
   .chain{display:flex;align-items:flex-start;justify-content:center;margin:44px auto;max-width:760px;}
   .stage{flex:1;min-width:0;text-align:center;padding:0 8px;}
   .node{width:34px;height:34px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:10px;}
   .node .material-symbols-outlined{font-size:20px;}
   .n-done{background:var(--teal);color:#fff;} .n-wait{background:#fff;border:2px solid var(--amber);color:var(--amber);} .n-pending{background:#fff;border:2px solid var(--line);color:var(--soft);}
   .stage h4{font-family:'Source Serif 4',serif;font-size:15px;font-weight:600;margin:0;}
   .stage .who{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--soft);margin-top:5px;text-transform:uppercase;letter-spacing:.04em;}
   .blocker{margin-top:8px;background:#f6e5e2;color:var(--coral);border-radius:8px;padding:6px 8px;font-size:11.5px;}
   .eyebrow{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--soft);margin-bottom:6px;}
   .conn{flex:0 0 36px;height:2px;background:var(--line);margin-top:34px;} .conn.solid{background:var(--teal);}
   .features{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin:24px 0 40px;}
   .feat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:22px;}
   .feat .material-symbols-outlined{font-size:24px;color:var(--primary);}
   .feat h3{font-family:'Source Serif 4',serif;font-size:18px;font-weight:600;margin:12px 0 8px;}
   .feat p{color:var(--soft);font-size:14px;line-height:1.55;margin:0;}
   .note{max-width:560px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;text-align:center;color:var(--soft);font-size:12.5px;}
   footer{text-align:center;padding:44px 0 56px;} footer .logo{justify-content:center;margin-bottom:16px;}
   @media(max-width:760px){.features{grid-template-columns:1fr;}.hero h1{font-size:32px;}.chain{flex-direction:column;align-items:center;gap:18px;}.conn{display:none;}}
   @media (prefers-reduced-motion:no-preference){.feat,.stage{animation:fin .4s ease-out both;}@keyframes fin{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}}
  </style></head>
  <body>
   <div class="wrap">
    <header>${logo}${gbtn}</header>
    <section class="hero">
      <h1>Stop chasing status updates over email.</h1>
      <p>Visible dependency chains that notify the right person automatically.</p>
      ${banner}
    </section>
    <section class="chain">
      <div class="stage"><div class="eyebrow">Step 1</div><div class="node n-done"><span class="material-symbols-outlined">check</span></div><h4>Design Assets</h4><div class="who">Assigned to Sarah</div></div>
      <div class="conn solid"></div>
      <div class="stage"><div class="eyebrow">Waiting on…</div><div class="node n-wait"><span class="material-symbols-outlined">hourglass_empty</span></div><h4>Frontend Implementation</h4><div class="who">Assigned to Marcus</div><div class="blocker">Blocker: Awaiting final copy for section 3.</div></div>
      <div class="conn"></div>
      <div class="stage"><div class="eyebrow">Step 3</div><div class="node n-pending"><span class="material-symbols-outlined">pending</span></div><h4>QA &amp; Deployment</h4><div class="who">Assigned to Team</div></div>
    </section>
    <section class="features">
      <div class="feat"><span class="material-symbols-outlined">visibility</span><h3>Visibility into handoffs</h3><p>Instantly see who holds the baton. No more searching through Slack threads or email chains to find the current bottleneck.</p></div>
      <div class="feat"><span class="material-symbols-outlined">summarize</span><h3>Forward-ready daily reports</h3><p>Automated digests summarize progress and highlight critical-path blockers before the daily standup even begins.</p></div>
      <div class="feat"><span class="material-symbols-outlined">diversity_3</span><h3>Team-wide transparency</h3><p>Foster a culture of accountability. When everyone sees the chain, dependencies become collaborative rather than combative.</p></div>
    </section>
    <div class="note">Built and tested by a three-person team over several weeks — this page is that test's result, not a finished product pitch.</div>
    <footer>${logo}<div style="margin-top:16px;">${gbtn}</div></footer>
   </div>
  </body></html>`;
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
