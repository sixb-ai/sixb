# Authorization

Authorization decides what each signed-in principal is allowed to see and do.

Sixb builds authorization from a few small layers:

- **Groups** place principals into named buckets.
- **Roles** give capabilities to groups.
- **Grants** are the capabilities a role gives — view objects and datasets, apply actions, run
  workflows, syncs, and pipelines.
- **Invite policies** decide who can invite new people into which groups.

At request time these definitions resolve into one set of grants per principal, and a scoped
runtime enforces them.

[Authentication](authentication.md) decides *who* a principal is; authorization decides what that
principal may do.

## Why it is useful

Most operational software needs more than "signed in or not":

- team members should see notes and a shared dataset, but not admin records
- only security admins should run sensitive workflows, syncs, or pipelines
- support staff should apply some actions, not all of them
- new teammates should be invited into the right group, by the right people

Grants give those rules one typed place to live. You describe access next to the ontology,
datasets, actions, workflows, syncs, and pipelines it protects, and the runtime applies it the same
way everywhere.

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

File: `security/roles/atlas-access.ts`

```ts
import { can, defineRole } from "@sixb/core"
import { acknowledgeNote } from "../../actions/acknowledge-note"
import { teamNotesDataset } from "../../datasets/auth-data"
import { Note } from "../../ontology/note"
import { teamMembers } from "../groups/team-members"

export const teamMemberAtlasAccess = defineRole("team-member.atlas-access", {
  grantedTo: [teamMembers],
  grants: [can.view(Note), can.view(teamNotesDataset), can.apply(acknowledgeNote)],
})
```

This role lets every member of `team-members` view `Note` objects, view the `teamNotesDataset`
dataset, and apply the `acknowledge-note` action — nothing else.

### What each part does

| Part | Meaning |
| --- | --- |
| `defineRole("team-member.atlas-access")` | Names the role |
| `grantedTo: [teamMembers]` | Groups whose members receive the role |
| `grants: [...]` | The capabilities the role gives |
| `can.view(Note)` | Allow viewing `Note` objects |
| `can.view(teamNotesDataset)` | Allow viewing a dataset |
| `can.apply(acknowledgeNote)` | Allow applying the `acknowledge-note` action |

## Grants

A grant pairs a capability with the definitions it covers. There are three capability builders —
`can.view`, `can.apply`, and `can.run` — which resolve to **six grant kinds**, one per protected
target family.

| Grant kind | Builder | Allows | Targets |
| --- | --- | --- | --- |
| `view:object` | `can.view(...)` | Read objects: `get`, `list`, `query`, telemetry, and related events | [Object types](../ontology/object-types.md) |
| `view:dataset` | `can.view(...)` | Read datasets and their versions | [Datasets](../data/datasets.md) |
| `apply:action` | `can.apply(...)` | Request actions | [Actions](../actions/overview.md) |
| `run:workflow` | `can.run(...)` | Start workflows | [Workflows](../workflows/overview.md) |
| `run:sync` | `can.run(...)` | Run syncs | [Syncs](../data/syncs.md) |
| `run:pipeline` | `can.run(...)` | Run pipelines | [Pipelines](../data/pipelines.md) |

`can.view` chooses between `view:object` and `view:dataset` from the definition you pass;
`can.run` chooses between `run:workflow`, `run:sync`, and `run:pipeline` the same way. Each is
type-checked, so mixing target families in one call does not compile.

### Selecting definitions

Each builder takes one definition, a list, or a breadth selector.

| Want | Write |
| --- | --- |
| One definition | `can.view(Note)` |
| Several definitions | `can.view([Note, Invoice])` |
| Every object type | `can.view(ontology.objects())` |
| Every dataset | `can.view(datasets())` |
| Every action | `can.apply(actions())` |
| Every workflow | `can.run(workflows())` |
| Every sync | `can.run(syncs())` |
| Every pipeline | `can.run(pipelines())` |
| Everything but a few | `can.view(ontology.objects().except([AdminNote]))` |

The breadth selectors are exported from `@sixb/core`:

| Selector | Target family |
| --- | --- |
| `ontology.objects()` | Object types |
| `datasets()` | Datasets |
| `actions()` | Actions |
| `workflows()` | Workflows |
| `syncs()` | Syncs |
| `pipelines()` | Pipelines |

Each selector picks its target family's whole registered universe. They are branded by target, so
`can.view(actions())` does not compile.

## Broad grants

Use breadth selectors for roles that should reach most of the system.

File: `security/roles/atlas-access.ts`

```ts
import { actions, can, datasets, defineRole, ontology, workflows } from "@sixb/core"
import { securityAdmins } from "../groups/security-admins"

export const securityAdminFullAccess = defineRole("security-admin.full-access", {
  grantedTo: [securityAdmins],
  grants: [
    can.view(ontology.objects()),
    can.view(datasets()),
    can.apply(actions()),
    can.run(workflows()),
  ],
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

| Option | Meaning |
| --- | --- |
| `grantedTo` | Groups whose members can send invitations |
| `canInviteTo` | Groups invitees may be placed into |
| `canInviteWithoutGroups` | Allow inviting people with no starting group |

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
above) can then invite the rest of the team. See [Authentication](authentication.md) for how
strategies and bootstrapping work.

## How grants are enforced

Grants are enforced through a **scoped runtime**. The raw `sixb` instance is privileged — it has
no authorization context and bypasses all grant checks. That is intended for trusted system code
(startup, syncs, projections, workers, tests).

To enforce a principal's grants, derive a scoped runtime with `sixb.as(context)`:

```ts
const scoped = sixb.as(authorizationContext)

await scoped.objects(Note).list()       // only if view:object covers Note
await scoped.requestAction(input)        // only if apply:action covers it
await scoped.runWorkflow(input)          // only if run:workflow covers it
await scoped.readEvents()                // events whose subject is visible
```

The scoped runtime is **default-deny**: any request without a covering grant throws, and listing
APIs return only the definitions the principal can reach.

### Scoped runtime surface

The scoped runtime exposes only operations whose grants are enforceable end to end. Catalog and
read methods are filtered to what the principal may reach.

| Method | Gated by |
| --- | --- |
| `objects(Type)`, `list`, `getObject` | `view:object` |
| `requestAction`, `requestActionAndWait` | `apply:action` |
| `runWorkflow` | `run:workflow` |
| `listDatasets`, `getDatasetById` | `view:dataset` |
| `listActions`, `getActionById` | `apply:action` |
| `listWorkflows`, `getWorkflowById` | `run:workflow` |
| `listSyncs`, `getSyncById` | `run:sync` |
| `listPipelines`, `getPipelineById` | `run:pipeline` |
| `readEvents` | subject visibility (see below) |

Writes, links, telemetry appends, and auth administration stay on the privileged runtime.

### Event visibility

There is no standalone "view events" capability. A principal sees a domain event only when it can
view, apply, or run the event's subject:

| Event topic | Visible when |
| --- | --- |
| `objects`, `telemetry` | can view the object type |
| `links` | can view both the source and target object types |
| `actions` | can apply the action (and view its object subject, if any) |
| `workflows` | can run the workflow |
| `syncs` | can run the sync |
| `pipelines` | can run the pipeline |
| `datasets` | can view the dataset |

Event filtering is fail-closed: an unmodeled topic is hidden. See [Events](../events/overview.md)
for the event model.

## With the server

The Sixb server does this for you. It resolves the session once per request and routes
authenticated traffic through `sixb.as(context)` automatically, so grants are enforced without
extra wiring. You define groups, roles, and invite policies; the server applies them. See the
[Server overview](../server/overview.md).

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
  datasets/
    auth-data.ts
  actions/
    acknowledge-note.ts
  security/
    groups/
      team-members.ts
      security-admins.ts
    roles/
      atlas-access.ts
    invite-policies/
      default-invites.ts
  sixb.config.ts
```

`createSixb()` discovers exported definitions from `security/groups/`, `security/roles/`, and
`security/invite-policies/` automatically. See [Project structure](../fundamentals/project-structure.md).

You can also register them explicitly:

```ts
import { createSixb } from "@sixb/core"
import { defaultInvites } from "./security/invite-policies/default-invites"
import { securityAdmins } from "./security/groups/security-admins"
import { teamMembers } from "./security/groups/team-members"
import { securityAdminFullAccess, teamMemberAtlasAccess } from "./security/roles/atlas-access"

export const sixb = createSixb({
  groups: [teamMembers, securityAdmins],
  roles: [teamMemberAtlasAccess, securityAdminFullAccess],
  invitePolicies: [defaultInvites],
})
```

## How to model authorization

Start from the people, not the permissions.

1. List the kinds of user your app has, and turn each into a group.
2. For each group, write one role describing what it can view, apply, and run.
3. Start narrow with explicit grants; widen to a breadth selector or `.except([...])` only when a
   group really needs broad reach.
4. Add an invite policy so the right group can grow the others.
5. Set `bootstrapGroups` so the first sign-in can administer everything else.

Good group and role names describe the people and their access:

- `team-members`, `security-admins`
- `team-member.atlas-access`
- `security-admin.full-access`

## Extra details

- Group, role, and invite policy ids must be unique.
- A role must list at least one group in `grantedTo` and at least one grant.
- Grants reference ontology, dataset, action, workflow, sync, and pipeline definitions by id and
  are validated against the registered runtime at startup.
- `can.view(Type)` also grants the type's subtypes.
- A principal's grants are the union of every role whose `grantedTo` groups it belongs to.
- The privileged runtime is the silent default — any authenticated route must run through
  `sixb.as(context)` (the server does this for you) or it bypasses grant checks.

The important first step is to name your groups clearly, then describe each group's access as one
role.
