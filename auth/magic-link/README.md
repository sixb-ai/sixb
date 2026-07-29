# @sixb/auth-magic-link

Magic-link email authentication strategy for Sixb.

Users enter an email address, receive a single-use link, and land signed in — no passwords to store, no
identity provider to configure. This is the strategy to start with.

## Install

```bash
bun add @sixb/auth-magic-link
```

## Usage

```ts
// security/auth.ts
import { magicLink } from "@sixb/auth-magic-link"

export const auth = magicLink({
  allowedDomains: ["example.com"],
  bootstrapUsers: ["ops@example.com"],
  sendMagicLink: async ({ email, subject, text, html }) => {
    await sendTransactionalEmail({ to: email, subject, text, html })
  },
})
```

| Option | Purpose |
| --- | --- |
| `allowedDomains` | Email domains allowed to sign in. Required — there is no implicit "anyone". |
| `sendMagicLink` | Required. Receives `{ email, url, subject, text, html }` — a rendered message plus the raw URL, so you can send it as-is or build your own. |
| `bootstrapUsers` | Addresses that get an account on first sign-in, so a fresh deployment has someone who can log in. |
| `bootstrapGroups` | Groups those first users join. |
| `magicLinkTtlMs` | Link lifetime. |
| `rateLimit` | Defaults to `{ perMinute: 5, perHour: 20 }`, or `false` to disable. |
| `publicUrl` | The origin to build links against, when it differs from the request origin. |
| `from`, `subject` | Defaults for the rendered message. |

Delivery is yours: the strategy renders the message and expects you to send it. Failures surface as
`MagicLinkError`.

## Rate limiting is per email, not per audience

The limiter is keyed by email address and shared across every audience served by one API process. A
user who signs into Atlas and then a custom app draws from the same bucket, so set `perMinute` to at
least the number of browser surfaces a person signs into — otherwise a normal second sign-in looks
like abuse.
