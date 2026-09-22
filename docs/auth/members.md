# Members & service accounts

Members are people who sign in to your app. Service accounts give scripts and external systems their own identity and permissions.

Both receive access through [groups and roles](authorization.md).

## Manage members

A membership policy controls who can invite users, assign groups, and suspend accounts. Export it from `security/policies/`.

This policy lets finance administrators manage the finance team:

```ts
// security/policies/finance-members.ts
import { defineMembershipPolicy } from "@sixb/core"
import { financeAdmins } from "../groups/finance-admins"
import { financeTeam } from "../groups/finance-team"

export const financeMembers = defineMembershipPolicy("finance-members", {
  grantedTo: [financeAdmins],
  scope: [financeTeam],
  can: ["invite", "assignGroups", "suspend"],
})
```

| Option | Purpose |
| --- | --- |
| `grantedTo` | Groups allowed to administer members. |
| `scope` | Groups those administrators may manage. |
| `can` | Allowed operations: `invite`, `assignGroups`, and `suspend`. Suspension also permits reactivation. |

Open **Settings → Members** in Atlas to invite users and manage membership. Invitations require email delivery in your [authentication strategy](authentication.md#configure-sign-in).

Administrators can manage an existing user only when all of that user's current groups are in scope. Group changes also require the new groups to be in scope. A user cannot suspend themselves or remove their own groups.

Suspending a user revokes their sessions. Reactivating them requires a new sign-in. Application access grants do not grant member-management permissions.

## Service accounts and tokens

Choose the credential that matches the caller:

| Credential | Use for |
| --- | --- |
| Personal access token | Your own scripts or tools, using a subset of your groups. |
| Service-account token | Unattended jobs or external systems with an independent identity. |

Manage credentials in **Settings → Tokens** in Atlas or through the [CLI](../cli/overview.md#tokens-and-service-accounts). Tokens are shown only when created. Save them in your secret manager and revoke them when no longer needed.

For example, after signing in with the CLI, create a service account in a group you are allowed to assign, then issue its token:

```bash
sixb service-account create --id finance-integration --name "Finance integration" --group finance-team
sixb service-account token create finance-integration --name "Production" --expires-in 30d
```

The group's roles determine what the token can do. Service-account tokens cannot create more credentials or administer service accounts.

Send the token as a bearer credential to supported [HTTP API](../server/overview.md#authenticate-a-request) routes. Browser sign-in and WebSocket connections use sessions instead.
