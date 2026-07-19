# Known limitations

This is an internal ~10-person prototype. These are deliberate simplifications for
this phase, documented so they don't get mistaken for finished, hardened behavior.

## Authentication has no impersonation protection (Phase 1)

Sign-in is a name picker with **no password**. Clicking a name sets a session cookie
identifying you as that user. There is nothing stopping anyone with network access to
the app from clicking someone else's name and acting as them.

- **Acceptable** for a small, trusted, internal group behind the org network.
- **Not acceptable** if this app is ever exposed beyond that trust boundary.

**Phase 2 fix:** real sign-in via Microsoft Entra ID (`@azure/msal-node`), which needs
an app registration in the org tenant (self-service or via IT). All identity flows
through `auth.js`'s `getCurrentUser(req)`, so only that module changes.

## No permission model

Anyone signed in can edit, reassign, or delete any task, and can generate the
team-wide report. There is no per-user/role gating yet. A real permission model
(e.g. only the assignee or creator can edit; team report is manager-only) is a
reasonable Phase 2 addition once we see how the team actually uses the app.

## Email delivery is best-effort

Flagging a dependency still saves even if the notification email fails to send; the
UI surfaces the failure but does not retry. Configure SMTP or SendGrid in `.env`.
