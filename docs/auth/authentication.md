# Authentication

Authentication identifies who is using your app. [Roles and permissions](authorization.md) control what they can see and do.

Configure sign-in through the `auth` option in `sixb.config.ts`. Sixb handles the sign-in routes, sessions, and sign-out for Atlas and your custom app.

## Configure sign-in

Choose a strategy:

| Strategy | Use when |
| --- | --- |
| [Magic link](https://github.com/sixb-ai/sixb/tree/main/auth/magic-link#readme) | Users should sign in through a link sent to their email. |
| [OIDC](https://github.com/sixb-ai/sixb/tree/main/auth/oidc#readme) | You use an identity provider such as Google Workspace. |

For magic links, install the strategy:

```bash
bun add @sixb/auth-magic-link
```

Add it to your existing configuration. `sendEmail` below is your application's email delivery function; Sixb supplies the rendered message.

```ts
// sixb.config.ts
import { magicLink } from "@sixb/auth-magic-link"
import { createSixb } from "@sixb/core"
import { sendEmail } from "./lib/email"
import { financeAdmins } from "./security/groups/finance-admins"

export const sixb = createSixb({
  // ...your existing providers
  auth: magicLink({
    allowedDomains: ["example.com"],
    bootstrapUsers: ["admin@example.com"],
    bootstrapGroups: [financeAdmins],
    sendMagicLink: async ({ email, subject, text, html }) => {
      await sendEmail({ to: email, subject, text, html })
    },
  }),
})
```

During local development, you can print the supplied `url` instead of sending an email. Use an email service in production.

For OIDC, install `@sixb/auth-oidc` and use its strategy as the `auth` value:

```ts
import { oidc } from "@sixb/auth-oidc"
import { financeAdmins } from "./security/groups/finance-admins"

const auth = oidc({
  issuer: "https://accounts.google.com",
  clientId: process.env.OIDC_CLIENT_ID!,
  clientSecret: process.env.OIDC_CLIENT_SECRET!,
  allowedDomains: ["example.com"],
  bootstrapUsers: ["admin@example.com"],
  bootstrapGroups: [financeAdmins],
})
```

Configure your provider's callback URL using the public API origin and `/auth/callback`. To support email invitations with OIDC, also supply `sendInvitation`. See the strategy's README for provider-specific options.

## Set up the first administrator

`bootstrapUsers` lists people who may create an account without an invitation. `bootstrapGroups` assigns their starting groups. Define the group in `security/groups/`:

```ts
// security/groups/finance-admins.ts
import { defineGroup } from "@sixb/core"

export const financeAdmins = defineGroup("finance-admins", {
  label: "Finance admins",
})
```

The group name does not grant access by itself. Add a [role](authorization.md) for its permissions and a [membership policy](members.md) if its members should invite or manage other users.

Bootstrap groups are applied on every sign-in. Use invitations for subsequent users rather than expanding the bootstrap list. `allowedDomains` restricts sign-in and invitations; it does not assign permissions.

## Sessions

Use persistent [storage](../infrastructure/overview.md) so accounts and sessions survive restarts. Browser sessions expire after 30 days without foreground activity by default. Active sessions renew automatically.

To change the lifetime, wrap the strategy in an auth configuration:

```ts
const DAY = 24 * 60 * 60 * 1000

const authentication = {
  strategy: auth,
  session: {
    idleTimeoutMs: 30 * DAY,
    renewalWindowMs: 7 * DAY,
    absoluteTimeoutMs: 90 * DAY,
  },
}
```

Use `authentication` as the `auth` option. The optional absolute lifetime applies to newly created sessions. Background polling and WebSocket traffic do not extend a session.

Sixb-served apps handle cookies, CSRF, and sign-in redirects. For a separate frontend, use the [browser client setup](../client/overview.md#standalone-browser-apps). To customize the sign-in screen, see [Custom sign-in](../apps/customization.md#custom-sign-in).

## Development and production

Omitting `auth` allows unrestricted local access. Production requires an authentication strategy unless you explicitly opt out. Configure the API and browser [public origins](../deployment/overview.md#configure-public-origins) before deploying.

For scripts and external services, use [personal access tokens or service accounts](members.md#service-accounts-and-tokens).
