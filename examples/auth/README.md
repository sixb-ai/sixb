# Auth example

A tiny Sixb app for testing authentication. Auth state (users, sessions,
groups) persists to a local SQLite database in `.sixb/`, so you stay signed in
across restarts. Pick the strategy with `SIXB_AUTH_MODE` (defaults to
`magic-link`). Delete `.sixb/` to start fresh.

## Quick start (magic link)

```bash
bun dev
```

1. Open http://localhost:3000
2. Enter `admin@example.com`
3. Open the sign-in link printed in **this terminal**

No email provider required — that's the whole flow.

## Send real emails (optional)

To deliver the email through [Resend](https://resend.com) instead of just
printing the link, add:

```bash
RESEND_API_KEY=re_...
SIXB_AUTH_EMAIL_FROM="Auth Example <you@yourdomain.com>"
```

## Groups & invitations

The example ships a small security setup under `security/` so you can test the
whole flow, not just sign-in:

- **Groups** — `security-admins` and `team-members` (`security/groups/`).
- **Bootstrap** — the first user to sign in (`admin@example.com`) is added to
  `security-admins`.
- **Invite policy** — security admins can invite people into `team-members`
  (`security/invite-policies/default-invites.ts`).
- **Roles** — `team-members` can view `Note`, view the team-notes dataset,
  and apply `acknowledge-note`. `security-admins` use wildcard grants: view all
  objects, view all datasets, apply all actions, run all workflows, and view events
  (`security/roles/atlas-access.ts`).
- **Seed data** — startup writes one `Note`, one `AdminNote`, and one
  `AccessRequest` (`seed.ts`).

So: sign in as `admin@example.com`, then use the admin UI in Atlas to invite a
teammate. They receive their own sign-in link — printed to the terminal, or
emailed if Resend is configured.

In Atlas, the teammate's object list should only include `Note` objects, the
dataset list should only include `auth.team_notes`, and the action list should
only include `acknowledge-note`. Requests for `AdminNote`, `AccessRequest`,
admin-only datasets, admin actions, workflows, and events are denied by the
scoped SDK that backs the server routes.

## Use OIDC instead (Google Workspace)

```bash
SIXB_AUTH_MODE=oidc \
SIXB_GOOGLE_CLIENT_ID=... \
SIXB_GOOGLE_CLIENT_SECRET=... \
SIXB_AUTH_ALLOWED_DOMAINS=yourcompany.com \
SIXB_AUTH_BOOTSTRAP_USERS=you@yourcompany.com \
bun dev
```

Sign-in redirects to Google, so the allowed domain and bootstrap user must be
your real Google Workspace domain and account.

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `SIXB_AUTH_MODE` | `magic-link` | `magic-link` or `oidc` |
| `SIXB_AUTH_ALLOWED_DOMAINS` | `example.com` | Comma-separated allowed email domains |
| `SIXB_AUTH_BOOTSTRAP_USERS` | `admin@example.com` | Comma-separated emails that can create the first account |
| `SIXB_GOOGLE_CLIENT_ID` / `..._SECRET` | — | Required for `oidc` |
| `RESEND_API_KEY` | — | Deliver emails via Resend (link is always printed too) |
| `SIXB_AUTH_EMAIL_FROM` | — | Sender address; required with `RESEND_API_KEY` |
