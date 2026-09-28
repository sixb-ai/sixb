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
| `trustedEmail` | Returns the address the provider vouches for. Defaults to `email` when `email_verified` is true. See [Microsoft Entra](#microsoft-entra). |
| `groups` | Returns the groups the provider grants the user. See [Groups from your identity provider](#groups-from-your-identity-provider). |
| `scope` | Requested scopes. Defaults to what is needed to identify the user. |
| `authorizationParams` | Extra query parameters on the authorization request, e.g. `hd` or `prompt`. |
| `sendInvitation` | Optional. Called with a rendered invitation message so you can email users who are not yet in the provider. |
| `publicUrl` | The origin to build the redirect URI against, when it differs from the request origin. |

Register the redirect URI your API serves (`/auth/callback`) with the provider before first
sign-in.

## When sign-in fails

When sign-in is refused for a reason the person can act on, the page says so, naming their address:
it hasn't been invited, its account is suspended, or its domain isn't allowed. A provider that sends
no trusted address is a setup mistake, so the server also logs which claims it did send. Other
failures show a generic page; set `SIXB_AUTH_DEBUG=1` to log them.

## How users are matched

A user is identified by the provider's subject (`sub`). Their address matters only on the first
sign-in: it links an existing user with that email, or claims that address's invitation or
bootstrap entry. After that, a changed address at the provider signs in to the same user.

Every sign-in needs an address the provider vouches for. Google, Okta, Auth0, and Keycloak vouch
with `email_verified`, which the default `trustedEmail` reads. Some providers send it as the string
`"true"`; that counts too.

## Google Workspace

1. Set the OAuth consent screen to **Internal**, so only your organization's accounts can sign in.
2. Create an OAuth client of type **Web application** with your redirect URI.
3. Use `issuer: "https://accounts.google.com"`. Optionally pass `authorizationParams: { hd: "example.com" }`
   to preselect the work account.

The defaults need no further configuration.

## Microsoft Entra

1. Register an application with **Accounts in this organizational directory only** and a **Web**
   redirect URI.
2. Create a client secret.
3. Configure the strategy with your tenant's issuer and `trustedEmail`:

```ts
export const auth = oidc({
  issuer: `https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID}/v2.0`,
  clientId: process.env.ENTRA_CLIENT_ID,
  clientSecret: process.env.ENTRA_CLIENT_SECRET,
  // Entra never sends email_verified. In a single-tenant app, your directory admins set these names.
  trustedEmail: (claims) => claims.preferred_username,
  bootstrapUsers: ["ops@example.com"],
})
```

- `preferred_username` is the name people sign in to Microsoft with. Every user has one, including
  users without a mailbox, so invite people by that name.
- Entra sends `email` only for users with a mailbox, and it can differ from the sign-in name, so it
  is not a reliable address to match invitations against.
- Use your tenant ID in the issuer. The shared `common` and `organizations` issuers let any
  organization's users sign in and are not supported.
- A user without a mailbox cannot receive an invitation email. Copy the invitation link from Atlas
  instead.

## Groups from your identity provider

Instead of inviting each person, let the provider decide who belongs to which group. `groups`
receives the sign-in's claims and returns group definitions:

```ts
import type { GroupDefinition } from "@sixb/core"
import { securityAdmins } from "./groups/security-admins"
import { teamMembers } from "./groups/team-members"

const appRoles: Record<string, GroupDefinition> = {
  "Sixb.Admin": securityAdmins,
  "Sixb.Member": teamMembers,
}

export const auth = oidc({
  // …issuer, client, and trustedEmail as above
  groups: (claims) => claims.roles?.flatMap((role) => appRoles[role] ?? []) ?? [],
})
```

- A user the provider grants at least one group signs in without an invitation. Anyone else
  still needs an invitation or a bootstrap entry.
- Groups are synced on every sign-in: new ones are added, and ones the provider no longer grants
  are removed. Groups an admin or an invitation gave the user are never touched.
- A change at the provider applies at the user's next sign-in. To cut someone off immediately,
  suspend them in Sixb.

In Microsoft Entra, use app roles:

1. In the app registration, open **App roles** and create one per group, e.g. `Sixb.Admin` and
   `Sixb.Member`, allowed for **Users/Groups**.
2. In **Enterprise applications**, open the app, set **Assignment required** to **Yes**, and
   assign users or Entra groups to the roles.

Assigned roles arrive in the `roles` claim. Prefer them to Entra's `groups` claim, which holds
group IDs rather than names and is left out for users in more than 200 groups.

Okta sends a `groups` claim once you configure one for the app. Keycloak needs a role mapper that
adds roles to the ID token under a claim named `roles`.
