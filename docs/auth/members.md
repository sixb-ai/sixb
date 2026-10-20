# Members & service accounts

Members are people who sign in to your app. Service accounts give scripts and external systems their own identity and permissions.

Both receive access through [groups and roles](authorization.md).

## Manage members

A membership policy controls who can invite users, assign groups, suspend accounts, and manage service accounts. Export it from `security/policies/`.

This policy lets finance administrators manage the finance team:

```ts
// security/policies/finance-members.ts
import { defineMembershipPolicy } from "@sixb/core"
import { financeAdmins } from "../groups/finance-admins"
import { financeTeam } from "../groups/finance-team"

export const financeMembers = defineMembershipPolicy("finance-members", {
  grantedTo: [financeAdmins],
  scope: [financeTeam],
  can: ["invite", "assignGroups", "suspend", "serviceAccounts"],
})
```

| Option | Purpose |
| --- | --- |
| `grantedTo` | Groups allowed to administer members. |
| `scope` | Groups those administrators may manage. |
| `can` | Allowed operations: `invite`, `assignGroups`, `suspend`, and `serviceAccounts`. Suspension also permits reactivation. `serviceAccounts` permits creating service accounts in scope, disabling them, and managing their tokens. |

Open **Settings › Members** in your [app](../apps/overview.md#settings) to invite users and manage membership. Invitations require email delivery in your [authentication strategy](authentication.md#configure-sign-in).

Administrators can manage an existing user only when all of that user's current groups are in scope. Group changes also require the new groups to be in scope. A user cannot suspend themselves or remove their own groups.

Suspending a user revokes their sessions. Reactivating them requires a new sign-in. Role grants do not give member-management permissions; membership policies do.

## Read the member directory

The member directory lists the project's members with their name, email, avatar, and status. Use it to show who a [user reference](../ontology/properties.md#reference-a-user) points at, or to let someone pick a colleague.

Reading it requires `can.view(project.users)`. `every.object()` and other grants do not include it.

```ts
// security/roles/team.ts
import { can, defineRole, project } from "@sixb/core"
import { team } from "../groups/team"

export const teamRole = defineRole("team", {
  grantedTo: [team],
  grants: [can.view(project.users)],
})
```

In server code, `sixb.users` reads the directory:

```ts
import { userRef } from "@sixb/core"

const { users } = await sixb.users.list({ search: "ava" })
const assignee = await sixb.users.get(userRef("usr_1"))
```

| Method | Returns |
| --- | --- |
| `list({ status, search, limit, offset })` | `{ users, hasMore, total }`, oldest member first. `status` is `"active"` (the default), `"suspended"`, or `"all"`. `search` matches part of a name or email, ignoring case, and has at most 200 characters. `limit` is 1 to 200, 50 by default. |
| `get(userRef(id))` | `{ id, email, displayName?, avatarUrl?, status }`, or `null` when no member has this id. |

Over HTTP, `GET /api/users?search=ava&status=all` takes the same options as query parameters, and `GET /api/users/:userId` returns one member or `404`. Both accept [access tokens](#service-accounts-and-tokens). In React, use [`useUsers`](../client/overview.md#list-members). From a terminal or the agent's sandbox, use `sixb users list`, `sixb users search <text>`, and `sixb users get <user-id>`.

Trusted code, such as workflows and actions, can always read the directory. An action or a workflow can therefore return directory data to a caller who lacks the grant, so return only what that caller should see. The agent and its tools read it with the permissions they run with: in a conversation, those of the person who asked. Shared links never read it.

## Service accounts and tokens

Choose the credential that matches the caller:

| Credential | Use for |
| --- | --- |
| Personal access token | Your own scripts or tools, using a subset of your groups. |
| Service-account token | Unattended jobs or external systems with an independent identity. |

Manage credentials in your app's **Settings › Developers** and **Settings › Service accounts**, or through the [CLI](../cli/overview.md#tokens-and-service-accounts). Tokens are shown only when created. Save them in your secret manager and revoke them when no longer needed.

Creating a token requires signing in, in the app or with `sixb login`. A personal access token can list and revoke tokens and manage service accounts but cannot create tokens, so no token can produce one with more access or a later expiry than its own.

Service accounts are managed by members whose membership policy includes `serviceAccounts`. A service account may join only groups in that policy's scope, and an administrator sees and manages only service accounts whose groups are all in scope.

For example, after signing in with the CLI, create a service account in a group your policy covers, then issue its token:

```bash
sixb service-account create --id finance-integration --name "Finance integration" --group finance-team
sixb service-account token create finance-integration --name "Production" --expires-in 30d
```

The group's roles determine what the token can do. Service-account tokens cannot create more credentials or administer service accounts.

Send the token as a bearer credential to supported [HTTP API](../server/overview.md#authenticate-a-request) routes. Browser sign-in and WebSocket connections use sessions instead.
