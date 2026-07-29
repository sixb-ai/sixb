# @sixb/auth-oidc

OpenID Connect authentication strategy for Sixb.

Signs users in through your existing identity provider — Google Workspace, Microsoft Entra, Okta,
Auth0, Keycloak, anything that speaks OIDC discovery. Use this when accounts already live somewhere
else; use [`@sixb/auth-magic-link`](../magic-link) when they do not.

## Install

```bash
bun add @sixb/auth-oidc
```

## Usage

```ts
// security/auth.ts
import { oidc } from "@sixb/auth-oidc"

export const auth = oidc({
  issuer: "https://accounts.google.com",
  clientId: process.env.OIDC_CLIENT_ID,
  clientSecret: process.env.OIDC_CLIENT_SECRET,
  allowedDomains: ["example.com"],
  bootstrapUsers: ["ops@example.com"],
})
```

| Option | Purpose |
| --- | --- |
| `issuer` | Issuer URL. Endpoints come from its discovery document. |
| `clientId`, `clientSecret` | Credentials for the application you registered with the provider. |
| `allowedDomains` | Email domains allowed to sign in. Omit only if the provider already restricts who can authenticate. |
| `bootstrapUsers` | Addresses that get an account on first sign-in, so a fresh deployment has someone who can log in. |
| `bootstrapGroups` | Groups those first users join. |
| `scope` | Requested scopes. Defaults to what is needed to identify the user. |
| `authorizationParams` | Extra query parameters on the authorization request, e.g. `hd` or `prompt`. |
| `sendInvitation` | Optional. Called with a rendered invitation message so you can email users who are not yet in the provider. |
| `publicUrl` | The origin to build the redirect URI against, when it differs from the request origin. |

Register the redirect URI your API serves with the provider before first sign-in. Failures surface as
`OidcAuthError`.
