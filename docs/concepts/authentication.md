# Authentication

Authentication establishes **who** a principal is. [Authorization](./authorization.md) is the
separate layer that decides **what** that principal may do.

Sixb builds authentication from a few small layers:

- **Strategy** decides how a user proves who they are — a magic link, an OIDC provider, or none.
- **Sessions** carry the signed-in state in a cookie and resolve it on each request.
- **Allowed domains and bootstrap** decide who may sign in, and who gets the first account.
- **Invitations** let the team grow after the first user is in.

You configure all of this through the `auth` option on `createSixb()`. The server ships the
sign-in, callback, and sign-out endpoints, so you rarely write request handling yourself.

## Why it is useful

Operational software needs a real identity behind every request:

- restrict sign-in to your company's email domain
- seed the first administrator without a chicken-and-egg problem
- invite teammates and place them into the right group
- keep people signed in across restarts, and sign them out everywhere when needed

Authentication gives you one place to declare the strategy, and a typed principal that flows into
every grant check.

## Pick a strategy

A strategy is the value you pass to `auth`. Each lives in its own package.

**Magic link** — email a one-time sign-in link. No external identity provider to set up.

```ts
import { createSixb } from "@sixb/core"
import { magicLink } from "@sixb/auth-magic-link"

export const sixb = createSixb({
  // ...storage, broker, and the rest of the runtime
  auth: magicLink({
    allowedDomains: ["example.com"],
    bootstrapUsers: ["admin@example.com"],
    sendMagicLink: async ({ email, url }) => {
      // In development, print it. In production, email it.
      console.log(`Sign-in link for ${email}: ${url}`)
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

## What each part does

Common options, using magic link as the example:

| Option | Meaning |
| --- | --- |
| `allowedDomains` | Email domains permitted to sign in |
| `bootstrapUsers` | Emails allowed to create the very first account |
| `bootstrapGroups` | Groups the first user is placed into on sign-in |
| `sendMagicLink` | Delivers the sign-in link (magic link only) |
| `from` / `subject` | Sender and subject line for the email |

OIDC swaps `sendMagicLink` for the provider connection — `issuer`, `clientId`, and
`clientSecret` — and uses `sendInvitation` to deliver invitation emails.

## Auth needs storage

Auth state — users, sessions, group memberships, and invitations — lives in the runtime's auth
storage. Use a persistent adapter so people stay signed in across restarts.

```ts
import { migrateSqliteStorage, SqliteStorage } from "@sixb/sqlite"

await migrateSqliteStorage(".sixb")

export const sixb = createSixb({
  storage: new SqliteStorage({ path: ".sixb" }),
  // ...auth, broker, and the rest of the runtime
})
```

Enabling auth without a storage adapter that provides auth storage is an error at startup.

## Allowed domains and bootstrap

`allowedDomains` is the gate: only emails on those domains can sign in. `bootstrapUsers` is the
exception that solves the first-account problem — those specific emails can create the first
account, and `bootstrapGroups` places that user into a group immediately.

```ts
import { magicLink } from "@sixb/auth-magic-link"
import { securityAdmins } from "./security/groups/security-admins"

auth: magicLink({
  allowedDomains: ["example.com"],
  bootstrapUsers: ["admin@example.com"],
  bootstrapGroups: [securityAdmins],
  sendMagicLink: async ({ email, url }) => console.log(`${email}: ${url}`),
})
```

The first sign-in as `admin@example.com` lands in `security-admins`. That group's
[role grants](./authorization.md) are what let it administer everything else — including inviting
the rest of the team.

## Invitations

After bootstrap, the team grows through invitations rather than more bootstrap users. Who can
invite whom into which groups is governed by [invite policies](./authorization.md). The active
strategy must support invitation delivery (magic link and OIDC both do).

The server exposes invitation management under `/api/auth/invitations`, and the built-in admin UI
uses it, so you usually do not call it directly.

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

Sessions are cached in-process briefly to absorb request bursts; the defaults are sensible, so
most apps leave `session` and `cookies` unset.

## Sign-in endpoints

When you serve the runtime, these endpoints are registered for you:

| Endpoint | Purpose |
| --- | --- |
| `GET /auth/sign-in` | Sign-in form (magic link) or redirect to the provider (OIDC) |
| `POST /auth/sign-in` | Request a magic link, or start the OIDC flow |
| `GET /auth/callback` | Complete the link or provider redirect and start a session |
| `POST /api/auth/sign-out` | End the current session |
| `POST /api/auth/sign-out-all` | End every session for the current user |

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
without extra wiring. See [Authorization](./authorization.md) for groups, roles, and grants.

## Extra details

- the strategy is the value passed to `auth`; the object form `{ strategy, session, cookies }`
  adds session and cookie tuning.
- `allowedDomains` is enforced on both sign-in and invitations.
- `bootstrapGroups` must reference groups registered with the runtime, or startup fails.
- sessions default to a 7-day lifetime; signing out everywhere revokes them across all devices.
- state-changing API routes are CSRF-protected with a double-submit token.
- auth and authorization are independent layers: authentication says who you are; authorization
  says what you may do.

The important first step is to pick a strategy, set `allowedDomains` and `bootstrapUsers`, then
let invitations and groups grow the team from there.
