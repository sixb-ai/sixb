# Auth example

A tiny Sixb project for testing authentication, invitations, and application grants. It serves
Atlas at `http://localhost:3000` and a small custom app at `http://localhost:3001`. Auth state
(users, sessions, groups) persists to a local SQLite database in `.sixb/`, so you stay signed in
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
  (`security/policies/default-membership.ts`).
- **Application access** — `team-members` can open the custom app but not Atlas.
  `security-admins` can open both applications.
- **Resource grants** — `team-members` can view `Note`, view the team-notes dataset,
  and apply `acknowledge-note`. `security-admins` use wildcard grants: view all
  objects, view all datasets, apply all actions, run all workflows, and view events
  (`security/roles/atlas-access.ts`).
- **Seed data** — startup writes one `Note`, one `AdminNote`, and one
  `AccessRequest` (`seed.ts`).

Try the complete flow:

1. Sign in to Atlas at `http://localhost:3000` as `admin@example.com`.
2. Go to **Settings → Members** and invite a teammate into `team-members`, choosing
   **Custom app** as the destination.
3. Open the sign-in link for the teammate. It should create an `app` session and land at
   `http://localhost:3001`, where the page shows the teammate, their groups, and granted notes.
4. Try signing that teammate into Atlas. Atlas should show the application access-denied page.
5. Return as the admin to edit the teammate's groups, suspend them, or reactivate them.
   Suspending revokes active sessions immediately; reactivation does not restore old sessions.

The custom app is intentionally small: it proves the selected invitation destination, audience
cookie, application grant, group membership, and scoped `Note` read in one screen.

It also exports `app/auth.tsx`, so app-audience magic-link requests use the branded Acme login,
check-email, confirmation, and expired-link states. Atlas intentionally keeps the generic Sixb
login to demonstrate the audience-specific fallback.

The magic-link email is branded too. `sixb.config.ts` sets the Acme subject and passes the
framework-generated `message.url` to `lib/magic-link-email.ts`, which owns the organization-specific
plain-text and HTML presentation. Link generation, expiry, and single-use behavior remain owned by
the magic-link strategy.

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
