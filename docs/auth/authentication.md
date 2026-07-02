# Authentication

Authentication establishes **who** a principal is. [Authorization](./authorization.md) is the
separate layer that decides **what** that principal may do.

Sixb assembles authentication from a few small pieces, all configured through the `auth` option on
`createSixb()`:

- **Strategy** — how a user proves who they are: a magic link, an OIDC provider, or none.
- **Sessions** — the signed-in state carried in a cookie and resolved on every request.
- **Allowed domains and bootstrap** — who may sign in, and who gets the very first account.
- **Invitations and members** — how the team grows and how admins manage existing users.

The server ships the sign-in, callback, and sign-out endpoints, so you rarely write request
handling yourself. See [Auth overview](./overview.md) for how the two layers fit together.

## Pick a strategy

A strategy is the value you pass to `auth`. Each lives in its own package and is built with a
factory function.

**Magic link** — email a one-time sign-in link. No external identity provider to set up.

```ts
import { createSixb } from "@sixb/core"
import { magicLink } from "@sixb/auth-magic-link"

export const sixb = await createSixb({
  // ...storage, broker, and the rest of the runtime
  auth: magicLink({
    allowedDomains: ["acme-corp.com"],
    bootstrapUsers: ["admin@acme-corp.com"],
    sendMagicLink: async (message) => {
      // In development, print it. In production, email it.
      console.log(`Sign-in link for ${message.email}: ${message.url}`)
    },
  }),
})
```

**OIDC** — sign in through an existing provider such as Google Workspace.

```ts
import { oidc } from "@sixb/auth-oidc"

auth: oidc({
  issuer: "https://accounts.google.com",
  clientId: process.env.SIXB_GOOGLE_CLIENT_ID ?? "",
  clientSecret: process.env.SIXB_GOOGLE_CLIENT_SECRET ?? "",
  allowedDomains: ["acme-corp.com"],
  bootstrapUsers: ["admin@acme-corp.com"],
})
```

## Magic link options

`magicLink(options)` from `@sixb/auth-magic-link`.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `allowedDomains` | `string[]` | — (required) | Email domains permitted to sign in; at least one |
| `sendMagicLink` | `(message) => Promise<void>` | — (required) | Delivers the sign-in email |
| `bootstrapUsers` | `string[]` | `[]` | Emails allowed to self-provision without an invitation |
| `bootstrapGroups` | `(string \| GroupDefinition)[]` | `[]` | Groups bootstrap users are placed into on sign-in |
| `id` | `string` | `"magic-link"` | Strategy id |
| `publicUrl` | `string` | request origin | Base origin used to build the callback link |
| `magicLinkTtlMs` | `number` | `900000` (15 min) | How long a link stays valid |
| `rateLimit` | `false \| { perMinute?, perHour? }` | `{ perMinute: 5, perHour: 20 }` | Per-email request limit, or `false` to disable |
| `from` | `string` | — | Sender address on the email |
| `subject` | `string` | `"Sign in to Sixb"` | Email subject line |

`sendMagicLink` receives a fully rendered message — `email`, `url`, `from?`, `subject`, `text`, and
`html` — so you deliver it however you like.

```ts
import { magicLink, type SendMagicLinkInput } from "@sixb/auth-magic-link"

auth: magicLink({
  allowedDomains: ["acme-corp.com"],
  bootstrapUsers: ["admin@acme-corp.com"],
  from: "auth@acme-corp.com",
  sendMagicLink: async (message: SendMagicLinkInput) => {
    await sendEmail({
      from: message.from,
      to: message.email,
      subject: message.subject,
      text: message.text,
      html: message.html,
    })
  },
})
```

## OIDC options

`oidc(options)` from `@sixb/auth-oidc`.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `issuer` | `string \| URL` | — (required) | OIDC issuer URL; discovery resolves the endpoints |
| `clientId` | `string` | — (required) | OAuth client id |
| `clientSecret` | `string` | — (required) | OAuth client secret |
| `allowedDomains` | `string[]` | unrestricted | Email domains permitted to sign in |
| `bootstrapUsers` | `string[]` | `[]` | Emails allowed to self-provision without an invitation |
| `bootstrapGroups` | `(string \| GroupDefinition)[]` | `[]` | Groups bootstrap users are placed into on sign-in |
| `id` | `string` | `"oidc"` | Strategy id |
| `publicUrl` | `string` | request origin | Base origin used to build the redirect URI |
| `scope` | `string` | `"openid email profile"` | Scopes requested at authorization |
| `authorizationParams` | `Record<string, string>` | `{}` | Extra query params on the authorize request |
| `sendInvitation` | `(message) => Promise<void>` | — | Delivers invitation emails; required to support invitations |
| `from` | `string` | — | Sender address on invitation emails |
| `subject` | `string` | `"You are invited to Sixb"` | Invitation email subject |

OIDC has no `sendMagicLink` — sign-in happens at the provider. Set `sendInvitation` (same message
shape: `email`, `url`, `from?`, `subject`, `text`, `html`) if you want to invite teammates by email.

## Auth needs storage

Auth state — users, sessions, group memberships, and invitations — lives in the runtime's storage.
Use a persistent adapter so people stay signed in across restarts.

```ts
import { migrateSqliteStorage, SqliteStorage } from "@sixb/sqlite"

await migrateSqliteStorage(".sixb")

export const sixb = await createSixb({
  storage: new SqliteStorage({ path: ".sixb" }),
  // ...auth, broker, and the rest of the runtime
})
```

Enabling auth without a storage adapter is an error at startup. See
[Infrastructure](../infrastructure/overview.md) for adapter choices.

## Allowed domains and bootstrap

`allowedDomains` is the gate: only emails on those domains can sign in. `bootstrapUsers` solves the
first-account problem — those specific emails may create an account without an invitation, and
`bootstrapGroups` places them into groups. Bootstrap groups are reconciled on **every** sign-in,
not just the first.

```ts
import { magicLink } from "@sixb/auth-magic-link"
import { financeAdmins } from "./security/groups/finance-admins"

auth: magicLink({
  allowedDomains: ["acme-corp.com"],
  bootstrapUsers: ["admin@acme-corp.com"],
  bootstrapGroups: [financeAdmins],
  sendMagicLink: async (message) => console.log(`${message.email}: ${message.url}`),
})
```

The first sign-in as `admin@acme-corp.com` lands in `finance-admins`. That group's
[role grants](./authorization.md) and membership policies are what let it run invoice actions,
invite teammates, and manage users. `bootstrapGroups` must reference groups registered with the
runtime, or startup fails — define them with `defineGroup` (see
[Authorization](./authorization.md)).

## Invitations and members

After bootstrap, the team grows through invitations rather than more bootstrap users. Who can invite
whom into which groups — and who can edit, suspend, or reactivate existing users — is governed by
[membership policies](./authorization.md). The active strategy must support invitation delivery:
magic link always does; OIDC does when `sendInvitation` is set.

The server exposes invitation and member management under `/api/auth/...`, and the built-in admin UI
uses those routes in **Settings → Members**, so you usually do not call them directly.
Programmatically, the runtime exposes them on `sixb.auth`:

```ts
const { invitation, delivery } = await sixb.auth.invite(request, {
  email: "newhire@acme-corp.com",
  groups: [teamMembers],
})
```

`invite(request, input, options)` takes an `input` of `email` plus optional `groups` / `groupIds`,
`expiresAt`, and `returnTo`. The companion methods are `listInvitations`, `revokeInvitation`, and
`getInvitationOptions`.

For existing users, the runtime exposes the same policy boundary through member-management methods:

```ts
const { members } = await sixb.auth.listMembers(request)
await sixb.auth.updateMemberGroups(request, {
  userId: "usr_123",
  groupIds: [teamMembers.id],
})
await sixb.auth.suspendMember(request, { userId: "usr_123" })
await sixb.auth.reactivateMember(request, { userId: "usr_123" })
```

`listMembers` returns only users inside the caller's membership-policy scope. Group assignment
requires both the user's current groups and the requested groups to be in scope. Suspending revokes
active sessions immediately; reactivation keeps old sessions revoked, so the user signs in again.

## Sessions and cookies

A successful sign-in sets a session cookie that the server resolves on every request. Pass the
object form of `auth` to tune session lifetime or cookie behavior.

```ts
auth: {
  strategy: magicLink({ /* ... */ }),
  session: {
    ttlMs: 7 * 24 * 60 * 60 * 1000, // default: 7 days
  },
  cookies: {
    sameSite: "strict",
    secure: "auto", // secure cookies when served over HTTPS
  },
}
```

| Group | Option | Default | Meaning |
| --- | --- | --- | --- |
| `session` | `ttlMs` | 7 days | Session lifetime |
| `session` | `cacheTtlMs` | `5000` (5s) | In-process cache window; `0` disables it |
| `cookies` | `sessionCookieName` | `"sixb_session"` | Session cookie name |
| `cookies` | `csrfCookieName` | `"sixb_csrf"` | CSRF cookie name |
| `cookies` | `cookieDomain` | — (host-only) | Cookie domain |
| `cookies` | `secure` | `"auto"` | `true`, `false`, or `"auto"` (secure over HTTPS) |
| `cookies` | `sameSite` | `"strict"` | Only `"strict"` is allowed |
| `cookies` | `csrfHttpOnly` | `false` | Whether the CSRF cookie is HttpOnly |

Sessions are cached in-process briefly to absorb request bursts. The defaults are sensible, so most
apps leave `session` and `cookies` unset.

## Sign-in endpoints

When you serve the runtime, these endpoints are registered for you:

| Endpoint | Purpose |
| --- | --- |
| `GET /auth/sign-in` | Sign-in form (magic link) or redirect to the provider (OIDC) |
| `POST /auth/sign-in` | Request a magic link, or start the OIDC flow |
| `GET /auth/callback` | Complete the link or provider redirect and start a session |
| `GET /api/auth/session` | Current session and CSRF token, or `{ authenticated: false }` |
| `POST /api/auth/sign-out` | End the current session |
| `POST /api/auth/sign-out-all` | End every session for the current user |
| `GET /api/auth/invitations` | List invitations |
| `POST /api/auth/invitations` | Create an invitation |
| `POST /api/auth/invitations/:invitationId/revoke` | Revoke an invitation |
| `GET /api/auth/invitation-options` | Groups and capabilities for the invite form |
| `GET /api/auth/membership-options` | Groups and capabilities for member management |
| `GET /api/auth/members` | List visible members with per-member capabilities |
| `PATCH /api/auth/members/:userId/groups` | Replace a member's groups |
| `POST /api/auth/members/:userId/suspend` | Suspend a member and revoke active sessions |
| `POST /api/auth/members/:userId/reactivate` | Reactivate a suspended member |

See [Server](../server/overview.md) for how routes are mounted.

## Development and production

In development you can run without auth — omit `auth` entirely and every request is treated as
privileged. The server refuses this in production: a deployed runtime must configure a real
strategy.

To run a deployed runtime without auth on purpose, opt in explicitly:

```ts
auth: { id: "disabled", kind: "disabled", allowDisabledInProduction: true }
```

This is deliberate — disabling auth in production should never happen by omission.

## From sign-in to authorization

Once a principal is signed in, its identity and group memberships resolve into an authorization
context that the server attaches to each request, so grant checks apply without extra wiring. The
resolved `Principal` is one of `user`, `serviceAccount`, or `system`.

A few things worth remembering:

- `allowedDomains` is enforced on both sign-in and invitations.
- Sessions default to a 7-day lifetime; `sign-out-all` revokes them across every device.
- State-changing API routes are CSRF-protected with a double-submit token.

## Next

- [Authorization](./authorization.md) — groups, roles, grants, and membership policies.
- [Auth overview](./overview.md) — how authentication and authorization fit together.
- [Server](../server/overview.md) — how the auth routes are mounted.
