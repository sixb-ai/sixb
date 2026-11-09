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
| `directory` | Checks everyone who signed in against the provider's directory every hour, and suspends whoever left. See [When someone leaves](#when-someone-leaves). |
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
failures show a generic page; set `SIXB_AUTH_DEBUG=1` to log them. One of them is a callback opened
in a browser other than the one that started sign-in, so a callback URL sent to someone else can't
sign them in to the sender's account.

## How users are matched

A user is identified by the provider's subject (`sub`). Their address matters only on the first
sign-in: it links an existing user with that email, or claims that address's invitation or
bootstrap entry. After that, a changed address at the provider signs in to the same user.

The user's name and picture come from the `name` and `picture` claims, and every sign-in updates
them. A claim the provider stops sending leaves the stored value as it was. People cannot change a
field the provider sends; one it does not send, they can.

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
- A user without a mailbox cannot receive an invitation email. Copy the invitation link from the
  app's Settings › Members instead.

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
- A change at the provider applies at the user's next sign-in, or at the next
  [directory check](#when-someone-leaves). To cut someone off immediately, suspend them in Sixb.

In Microsoft Entra, use app roles:

1. In the app registration, open **App roles** and create one per group, e.g. `Sixb.Admin` and
   `Sixb.Member`, allowed for **Users/Groups**.
2. In **Enterprise applications**, open the app, set **Assignment required** to **Yes**, and
   assign users or Entra groups to the roles.

Assigned roles arrive in the `roles` claim. Prefer them to Entra's `groups` claim, which holds
group IDs rather than names and is left out for users in more than 200 groups.

Okta sends a `groups` claim once you configure one for the app. Keycloak needs a role mapper that
adds roles to the ID token under a claim named `roles`.

## When someone leaves

Disabling or unassigning someone at the provider stops their next sign-in, but Sixb would not hear
of it. A `directory` checks everyone who signed in, every hour, and Sixb suspends whoever it reports
gone: their sessions end, their access tokens are refused, and the connections they made with their own
accounts are revoked. The same check syncs groups, so a role change applies within the hour instead
of at the next sign-in.

For Microsoft Entra, use `entraDirectory()`. It reads Microsoft Graph with the app registration and
secret the strategy already uses:

```ts
import { oidc } from "@sixb/auth-oidc"
import { entraDirectory } from "@sixb/auth-oidc/entra"

export const auth = oidc({
  // …issuer, client, trustedEmail, and groups as above
  directory: entraDirectory(),
})
```

1. In the app registration, open **API permissions** › **Add a permission** › **Microsoft Graph** ›
   **Application permissions**, and add `Application.Read.All` and `User.Read.All`. Add
   `GroupMember.Read.All` too when you assign app roles to groups.
2. Select **Grant admin consent**.

None of these needs a premium license, though assigning the app to groups at all needs Microsoft
Entra ID P1, and only a group's direct members are assigned. A person is suspended when they are deleted, disabled, or
unassigned while **Assignment required** is on. Anyone else stays active, and their current app
roles go through `groups` as their `roles` claim.

| Option | Purpose |
| --- | --- |
| `intervalMs` | How often to check. Defaults to one hour, at least one minute. |
| `graphUrl` | Microsoft Graph's origin, for a national cloud. |

What to expect:

- People are looked up by the `oid` claim of their last sign-in, so the check covers everyone who
  signed in. An invitation nobody accepted expires on its own.
- The directory lifts only the suspensions it made. Someone an administrator suspended stays
  suspended.
- Entra takes a little while to spread a change, and changing someone's role in the portal removes
  the old role before adding the new one. So a check that would suspend or reactivate someone reads
  again a minute later, and applies only what both reads agree on.
- A check that fails, or that would suspend more than a quarter of the members at once (and more
  than two), suspends no one and reports the failure to `onError`. The next check tries again.
- Reactivating someone in **Settings › Members** while Entra still reports them gone lasts only
  until the next check, which suspends them again.
- Checks run in the orchestrator: `sixb dev` runs one, and so does `sixb orchestrator` in production.

Another provider's directory is an object with a `check` that answers for each person who signed in,
keyed by subject:

```ts
import type { OidcDirectory } from "@sixb/auth-oidc"

export const oktaDirectory: OidcDirectory = {
  async check({ identities, signal }) {
    const verdicts = new Map()
    for (const { subject } of identities) {
      const user = await fetchOktaUser(subject, signal) // your Okta API call
      verdicts.set(
        subject,
        user.status === "ACTIVE" ? { status: "active", claims: { groups: user.groups } } : { status: "inactive" }
      )
    }
    return verdicts
  },
}
```

Leave out a person the directory can't answer for, and nothing changes for them. Return `claims`
only when you know them; they are merged over the last sign-in's and passed to `groups`. Set
`confirmAfterMs: 0` when your directory always answers with its latest state, so a change applies
without waiting for a second read.

