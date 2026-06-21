# Authorization

Authorization decides what each signed-in principal is allowed to see and do.

Sixb builds authorization from a few small layers:

- **Groups** place principals into named buckets.
- **Roles** give capabilities to groups.
- **Grants** are the capabilities a role gives — view objects, apply actions, run workflows.
- **Invite policies** decide who can invite new people into which groups.

At request time these definitions resolve into one set of grants per principal, and a scoped
runtime enforces them.

## Why it is useful

Most operational software needs more than "signed in or not":

- team members should see notes, but not admin records
- only security admins should run sensitive workflows
- support staff should apply some actions, not all of them
- new teammates should be invited into the right group, by the right people

Grants give those rules one typed place to live. You describe access next to the ontology,
actions, and workflows it protects, and the runtime applies it the same way everywhere.

## Define a group

A group is a named bucket. Principals belong to groups; roles and invite policies are written
against groups, never against individual users.

Files: `security/groups/team-members.ts` and `security/groups/security-admins.ts`

```ts
import { defineGroup } from "@sixb/core"

export const teamMembers = defineGroup("team-members", {
  label: "Team members",
})
```

```ts
import { defineGroup } from "@sixb/core"

export const securityAdmins = defineGroup("security-admins", {
  label: "Security admins",
})
```

## Define a role

A role bundles grants and attaches them to one or more groups. Every member of a `grantedTo`
group receives the role's grants.

File: `security/roles/access.ts`

```ts
import { can, defineRole } from "@sixb/core"
import { acknowledgeNote } from "../../actions/acknowledge-note"
import { Note } from "../../ontology/note"
import { teamMembers } from "../groups/team-members"

export const teamMemberAccess = defineRole("team-member.access", {
  grantedTo: [teamMembers],
  grants: [can.view(Note), can.apply(acknowledgeNote)],
})
```

This role lets every member of `team-members` view `Note` objects and apply the
`acknowledge-note` action — nothing else.

## What each part does

| Part | Meaning |
| --- | --- |
| `defineRole("team-member.access")` | Names the role |
| `grantedTo: [teamMembers]` | Groups whose members receive the role |
| `grants: [...]` | The capabilities the role gives |
| `can.view(Note)` | Allow viewing `Note` objects |
| `can.apply(acknowledgeNote)` | Allow applying the `acknowledge-note` action |

## Grants

A grant pairs a capability with the definitions it covers. There are three capabilities, one per
protected surface.

| Capability | Allows | Targets |
| --- | --- | --- |
| `can.view(...)` | Read objects: `get`, `list`, `query`, and related events | Object types |
| `can.apply(...)` | Request actions | Actions |
| `can.run(...)` | Start workflows | Workflows |

Each builder takes one definition, a list, or a breadth selector.

| Want | Write |
| --- | --- |
| One definition | `can.view(Note)` |
| Several definitions | `can.view([Note, Invoice])` |
| Every object type | `can.view(ontology.objects())` |
| Every action | `can.apply(actions())` |
| Every workflow | `can.run(workflows())` |
| Everything but a few | `can.view(ontology.objects().except([AdminNote]))` |

`ontology.objects()`, `actions()`, and `workflows()` select a capability's whole registered
universe. They are type-checked against the capability, so `can.view(actions())` does not
compile.

## Broad grants

Use breadth selectors for roles that should reach most of the system.

File: `security/roles/access.ts`

```ts
import { actions, can, defineRole, ontology, workflows } from "@sixb/core"
import { securityAdmins } from "../groups/security-admins"

export const securityAdminAccess = defineRole("security-admin.full-access", {
  grantedTo: [securityAdmins],
  grants: [can.view(ontology.objects()), can.apply(actions()), can.run(workflows())],
})
```

Add `.except([...])` to keep a selection broad while carving out a few definitions.

```ts
can.view(ontology.objects().except([AdminNote]))
```

This grants every object type except `AdminNote`.

## Invite policies

An invite policy says which groups can invite new people, and which groups they can place them
into. Without a matching policy, a principal cannot send invitations.

File: `security/invite-policies/default-invites.ts`

```ts
import { defineInvitePolicy } from "@sixb/core"
import { securityAdmins } from "../groups/security-admins"
import { teamMembers } from "../groups/team-members"

export const defaultInvites = defineInvitePolicy("default-invites", {
  grantedTo: [securityAdmins],
  canInviteTo: [teamMembers],
})
```

Security admins can now invite people into `team-members`. A policy must declare `canInviteTo`
groups, set `canInviteWithoutGroups: true`, or both.

## How principals join groups

Roles and invite policies act on group membership, so principals need a way into a group.

- **Bootstrap** — the auth strategy's `bootstrapGroups` are applied to the first allowed user to
  sign in. This seeds the initial admins.
- **Invitations** — after that, members covered by an invite policy invite teammates into the
  groups that policy allows.

```ts
import { magicLink } from "@sixb/auth-magic-link"
import { securityAdmins } from "./security/groups/security-admins"

auth: magicLink({
  allowedDomains: ["example.com"],
  bootstrapUsers: ["admin@example.com"],
  bootstrapGroups: [securityAdmins],
})
```

The first user to sign in as `admin@example.com` lands in `security-admins`, which (via the role
above) can then invite the rest of the team.

## How grants are enforced

Grants are enforced through a **scoped runtime**. The raw `sixb` instance is privileged — it has
no authorization context and bypasses all grant checks. That is intended for trusted system code
(startup, syncs, projections, workers, tests).

To enforce a principal's grants, derive a scoped runtime with `sixb.as(context)`:

```ts
const scoped = sixb.as(authorizationContext)

await scoped.objects(Note).list()    // only if can.view(Note)
await scoped.requestAction(input)     // only if can.apply(...)
await scoped.runWorkflow(input)       // only if can.run(...)
```

The scoped runtime is **default-deny**: any request without a covering grant throws, and listing
APIs return only the definitions the principal can reach. It exposes only operations whose grants
are enforceable end to end — reads, actions, workflows, and events. Writes, links, telemetry, and
auth administration stay on the privileged runtime.

## With the server

The Sixb server does this for you. It resolves the session once per request and routes
authenticated traffic through `sixb.as(context)` automatically, so grants are enforced without
extra wiring. You define groups, roles, and invite policies; the server applies them.

To build a context yourself in a custom integration, resolve it from the request:

```ts
const context = await sixb.auth.createAuthorizationContext(request)
const scoped = sixb.as(context)
```

## Convention

Put security definitions under `security/`, split by kind, and export them.

```txt
your-project/
  ontology/
    note.ts
  actions/
    acknowledge-note.ts
  security/
    groups/
      team-members.ts
      security-admins.ts
    roles/
      access.ts
    invite-policies/
      default-invites.ts
  sixb.config.ts
```

`createSixb()` discovers exported definitions from `security/groups/`, `security/roles/`, and
`security/invite-policies/` automatically.

You can also register them explicitly:

```ts
import { createSixb } from "@sixb/core"
import { defaultInvites } from "./security/invite-policies/default-invites"
import { securityAdmins } from "./security/groups/security-admins"
import { teamMembers } from "./security/groups/team-members"
import { securityAdminAccess, teamMemberAccess } from "./security/roles/access"

export const sixb = createSixb({
  groups: [teamMembers, securityAdmins],
  roles: [teamMemberAccess, securityAdminAccess],
  invitePolicies: [defaultInvites],
})
```

## How to model authorization

Start from the people, not the permissions.

1. List the kinds of user your app has, and turn each into a group.
2. For each group, write one role describing what it can view, apply, and run.
3. Start narrow with explicit grants; widen to `ontology.objects()` or `.except([...])` only
   when a group really needs broad reach.
4. Add an invite policy so the right group can grow the others.
5. Set `bootstrapGroups` so the first sign-in can administer everything else.

Good group and role names describe the people and their access:

- `team-members`, `security-admins`
- `team-member.access`
- `security-admin.full-access`

## Extra details

- group, role, and invite policy ids must be unique.
- a role must list at least one group in `grantedTo` and at least one grant.
- grants reference ontology, action, and workflow definitions by id and are validated against the
  registered runtime at startup.
- `can.view(Type)` also grants the type's subtypes.
- a principal's grants are the union of every role whose `grantedTo` groups it belongs to.
- there is no separate "view events" capability: a principal sees a domain event only when it can
  view, apply, or run the event's subject.
- the privileged runtime is the silent default — any authenticated route must run through
  `sixb.as(context)` (the server does this for you) or it bypasses grant checks.

The important first step is to name your groups clearly, then describe each group's access as one
role.
