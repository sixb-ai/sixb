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

## Groups & member management

The example ships a small security setup under `security/` so you can test the
whole flow, not just sign-in:

- **Groups** — `security-admins` and `team-members` (`security/groups/`).
- **Bootstrap** — the first user to sign in (`admin@example.com`) is added to
  `security-admins`.
- **Membership policy** — security admins can invite, assign groups, suspend,
  and reactivate members in `security-admins` and `team-members`
  (`security/policies/default-membership.ts`). Group-less invitations are also
  allowed; those users can sign in but receive no group-derived grants until an
  admin assigns a group.
- **Roles** — `team-members` can view `Note`, view the team-notes dataset,
  and apply `acknowledge-note`. `security-admins` use wildcard grants: view all
  objects, view all datasets, apply all actions, run all workflows, and view events
  (`security/roles/atlas-access.ts`).
- **Seed data** — startup writes one `Note`, one `AdminNote`, and one
  `AccessRequest` (`seed.ts`).

Try this in Atlas:

1. Sign in as `admin@example.com`.
2. Go to **Settings → Members**, click **Invite member**, and invite a teammate
   into `team-members` (or invite with no groups to test default-deny access).
3. Open the sign-in link for the teammate — printed to the terminal, or emailed
   if Resend is configured.
4. Return as the admin and go to **Settings → Members**. You can edit the
   teammate's groups, suspend them, and reactivate them. Suspending revokes
   active sessions immediately; reactivation does not restore old sessions.

In Atlas, a `team-members` user should only see `Note` objects, the
`auth.team_notes` dataset, and the `acknowledge-note` action. A group-less user
should see no domain resources. Requests for `AdminNote`, `AccessRequest`,
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
