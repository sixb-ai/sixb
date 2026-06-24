# Authentication

Authentication establishes **who** a principal is. [Authorization](./authorization.md) is the
separate layer that decides **what** that principal may do.

Sixb builds authentication from a few small layers:

- **Strategy** — how a user proves who they are: a magic link, an OIDC provider, or none.
- **Sessions** — the signed-in state carried in a cookie and resolved on every request.
- **Allowed domains and bootstrap** — who may sign in, and who gets the first account.
- **Invitations** — how the team grows after the first user is in.

Configure all of it through the `auth` option on `createSixb()`. The server ships the sign-in,
callback, and sign-out endpoints, so you rarely write request handling yourself. See
[Auth overview](./overview.md) for how authentication and authorization fit together.

## Pick a strategy

A strategy is the value you pass to `auth`. Each lives in its own package and is constructed with
a factory function.

**Magic link** — email a one-time sign-in link. No external identity provider to set up.

```ts
import { createSixb } from "@sixb/core"
import { magicLink } from "@sixb/auth-magic-link"

export const sixb = await createSixb({
  // ...storage, broker, and the rest of the runtime
  auth: magicLink({
    allowedDomains: ["example.com"],
    bootstrapUsers: ["admin@example.com"],
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
  allowedDomains: ["yourcompany.com"],
  bootstrapUsers: ["you@yourcompany.com"],
})
```

## Magic link options

`magicLink(options)` from `@sixb/auth-magic-link`.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `allowedDomains` | `string[]` | — (required) | Email domains permitted to sign in; must contain at least one |
| `sendMagicLink` | `(message) => Promise<void>` | — (required) | Delivers the sign-in email |
| `bootstrapUsers` | `string[]` | `[]` | Emails allowed to self-provision without an invitation |
| `bootstrapGroups` | `(string \| GroupDefinition)[]` | `[]` | Groups bootstrap users are placed into on sign-in |
| `id` | `string` | `"magic-link"` | Strategy id |
| `publicUrl` | `string` | request origin | Base origin used to build the callback link |
| `magicLinkTtlMs` | `number` | `900000` (15 min) | How long a link stays valid |
| `rateLimit` | `false \| { perMinute?, perHour? }` | `{ perMinute: 5, perHour: 20 }` | Per-email request limit, or `false` to disable |
| `from` | `string` | — | Sender address on the email |
| `subject` | `string` | `"Sign in to Sixb"` | Email subject line |

`sendMagicLink` receives a fully rendered message: `email`, `url`, `from?`, `subject`, `text`, and
`html`. Deliver it however you like (in development, log `message.url`).

```ts
import { magicLink, type SendMagicLinkInput } from "@sixb/auth-magic-link"

auth: magicLink({
  allowedDomains: ["example.com"],
  bootstrapUsers: ["admin@example.com"],
  from: "auth@example.com",
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

Unlike magic link, OIDC has no `sendMagicLink` — sign-in happens at the provider. Provide
`sendInvitation` (it receives the same message shape: `email`, `url`, `from?`, `subject`, `text`,
`html`) if you want to invite teammates by email.

## Auth needs storage

Auth state — users, sessions, group memberships, and invitations — lives in the runtime's auth
storage. Use a persistent adapter so people stay signed in across restarts.

```ts
import { migrateSqliteStorage, SqliteStorage } from "@sixb/sqlite"

await migrateSqliteStorage(".sixb")

export const sixb = await createSixb({
  storage: new SqliteStorage({ path: ".sixb" }),
  // ...auth, broker, and the rest of the runtime
})
```

Enabling auth without a storage adapter that provides auth storage is an error at startup. See
[Infrastructure](../infrastructure/overview.md) for adapter choices.

## Allowed domains and bootstrap

`allowedDomains` is the gate: only emails on those domains can sign in. `bootstrapUsers` is the
exception that solves the first-account problem — those specific emails may create an account
without an invitation, and `bootstrapGroups` places them into groups on sign-in. Bootstrap groups
are reconciled on every sign-in, not only the first one.

```ts
import { magicLink } from "@sixb/auth-magic-link"
import { securityAdmins } from "./security/groups/security-admins"

auth: magicLink({
  allowedDomains: ["example.com"],
  bootstrapUsers: ["admin@example.com"],
  bootstrapGroups: [securityAdmins],
  sendMagicLink: async (message) => console.log(`${message.email}: ${message.url}`),
})
```

The first sign-in as `admin@example.com` lands in `security-admins`. That group's
[role grants](./authorization.md) are what let it administer everything else — including inviting
the rest of the team. `bootstrapGroups` must reference groups registered with the runtime, or
startup fails. Groups are defined with `defineGroup` — see [Authorization](./authorization.md).

## Invitations

After bootstrap, the team grows through invitations rather than more bootstrap users. Who can
invite whom into which groups is governed by [invite policies](./authorization.md). The active
strategy must support invitation delivery — magic link always does; OIDC does when `sendInvitation`
is set.

The server exposes invitation management under `/api/auth/invitations`, and the built-in admin UI
uses it, so you usually do not call it directly. Programmatically, the runtime exposes it on
`sixb.auth`:

```ts
const { invitation, delivery } = await sixb.auth.invite(request, {
  email: "teammate@example.com",
  groups: [teamMembers],
})
```

`invite(request, input, options)` takes an `input` of `email` plus optional `groups` / `groupIds`,
`expiresAt`, and `returnTo`. The companion methods are `listInvitations`, `revokeInvitation`, and
`getInvitationOptions`.

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

Sessions are cached in-process briefly to absorb request bursts; the defaults are sensible, so most
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

See [Server](../server/overview.md) for how routes are mounted.

## Development and production

In development you can run without auth — omit `auth` entirely and every request is treated as
privileged. The server refuses to do this in production: a deployed runtime must configure a real
strategy.

To run a deployed runtime without auth on purpose, opt in explicitly:

```ts
auth: { id: "disabled", kind: "disabled", allowDisabledInProduction: true }
```

This is deliberate — disabling auth in production should never happen by omission.

## From sign-in to authorization

Once a principal is signed in, its identity and group memberships resolve into an authorization
context. The server attaches that context to the request automatically, so grant checks apply
without extra wiring. The resolved `Principal` is one of `user`, `serviceAccount`, or `system`.

## Notes

- The strategy is the value passed to `auth`; the object form `{ strategy, session, cookies }`
  adds session and cookie tuning.
- `allowedDomains` is enforced on both sign-in and invitations.
- Sessions default to a 7-day lifetime; signing out everywhere revokes them across all devices.
- State-changing API routes are CSRF-protected with a double-submit token.
- Authentication says who you are; [authorization](./authorization.md) says what you may do.

The first step is to pick a strategy, set `allowedDomains` and `bootstrapUsers`, then let
invitations and groups grow the team from there. See [Authorization](./authorization.md) for
groups, roles, and grants.
