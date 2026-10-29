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
const ava = await sixb.users.get({ email: "ava@acme.com" })
```

| Method | Returns |
| --- | --- |
| `list({ status, search, limit, offset })` | `{ users, hasMore, total }`, oldest member first. `status` is `"active"` (the default), `"suspended"`, or `"all"`. `search` matches part of a name or email, ignoring case, and has at most 200 characters. `limit` is 1 to 200, 50 by default. |
| `get(userRef(id))` | `{ id, email, displayName?, avatarUrl?, status }`, or `null` when no member has this id. |
| `get({ email })` | The member with exactly this email, ignoring case, suspended or not, or `null`. Use `list({ search })` to match part of an address. |

Over HTTP, `GET /api/users?search=ava&status=all` takes the same options as query parameters, and `GET /api/users/:userId` returns one member or `404`. `GET /api/users?email=ava@acme.com` looks a member up by email and returns a page of at most one; it takes no other option. All of them accept [access tokens](#service-accounts-and-tokens). In React, use [`useUsers`](../client/overview.md#list-members). From a terminal or the agent's sandbox, use `sixb users list`, `sixb users search <text>`, and `sixb users get <user-id|email>`.

An object query can include the profiles of the members a property names, with [`expand(Task.p.assignee)`](../objects/querying.md#include-the-members-a-property-names). It reads the same directory and needs the same grant.

Trusted code, such as workflows and actions, can always read the directory. An action or a workflow can therefore return directory data to a caller who lacks the grant, so return only what that caller should see. The agent and its tools read it with the permissions they run with: in a conversation, those of the person who asked. Shared links never read it.

## React to member changes

Sixb publishes an event when membership changes. Use them to onboard new members, sync a directory, or audit changes:

| Event | When | Payload |
| --- | --- | --- |
| `user.joined` | A person signs in for the first time, which creates their account. | `user`, `invitationId` when they accepted an invitation |
| `user.invited` | An invitation is created, and sent when your sign-in method sends invitations. Inviting the same person again publishes it again. | `invitationId`, `email`, `expiresAt`, `requestedBy` |
| `user.suspended`, `user.reactivated` | An administrator changes the member's status. | `user`, `requestedBy` |
| `user.profile.updated` | The member's name or picture changes. | `user`, `changes`, and `requestedBy` when the member edited it. Without `requestedBy`, their identity provider changed it at sign-in. |

`user` is the member's profile, as [`sixb.users.get`](#read-the-member-directory) returns it. `changes` holds only the fields that changed, each with its operation (`created`, `updated` or `cleared`) and values. Saving the values a member already has, such as the same name, publishes nothing.

Select them with `events.users()` in a schedule, and start a workflow from it:

```ts
// schedules/member-joined.ts
import { defineSchedule, events } from "@sixb/core"

export const memberJoined = defineSchedule("member-joined").on(events.users().joined())
```

```ts
// workflows/welcome-member.ts
import { defineWorkflow } from "@sixb/core"
import { memberJoined } from "../schedules/member-joined"
import { sendWelcome } from "./steps/send-welcome"

export const welcomeMember = defineWorkflow("welcome-member")
  .input({ email: "string" })
  .when(memberJoined, ({ event }) => ({ email: event.user.email }))
  .then(sendWelcome)
```

The other selectors are `.invited()`, `.suspended()`, `.reactivated()`, and `.profileUpdated()`.

Reading these events requires `can.view(project.users)`, like the directory. Workflows and other trusted code always receive them.

An event is published after the change is saved. If the event stream is unavailable at that moment, the change is kept, the event is lost, and the failure is reported to [`onError`](../logging/overview.md#report-failures) as `event.delivery.failed`. Do not rely on these events as the only record of membership: read the directory for the current state.

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
