# Authorization

Authorization decides what each signed-in principal may see and do. Reach for it when "signed in
or not" is not enough — finance admins run sensitive workflows, team members read invoices but
can't refund them, and new teammates land in the right group.

[Authentication](authentication.md) decides *who* a principal is; authorization decides what they
may do. Sixb builds it from four small layers:

| Layer | Role |
| --- | --- |
| **Groups** | Named buckets that principals belong to |
| **Roles** | Bundles of grants attached to groups |
| **Grants** | The capabilities a role gives — view, apply, run |
| **Membership policies** | Who can administer membership for which groups |

At request time these resolve into one set of grants per principal, and a scoped runtime enforces
them. You describe access next to the ontology, datasets, actions, workflows, syncs, and pipelines
it protects, and the runtime applies it the same way everywhere.

## Define a group

A group is a named bucket. Principals belong to groups; roles and membership policies are written
against groups, never against individual users.

```ts
// security/groups/team-members.ts
import { defineGroup } from "@sixb/core"

export const teamMembers = defineGroup("team-members", {
  label: "Team members",
})
```

```ts
// security/groups/finance-admins.ts
import { defineGroup } from "@sixb/core"

export const financeAdmins = defineGroup("finance-admins", {
  label: "Finance admins",
})
```

## Define a role

A role bundles grants and attaches them to one or more groups. Every member of a `grantedTo`
group receives the role's grants.

```ts
// security/roles/billing-access.ts
import { can, defineRole } from "@sixb/core"
import { sendReminder } from "../../actions/sendReminder"
import { Customer } from "../../ontology/customer"
import { Invoice } from "../../ontology/invoice"
import { teamMembers } from "../groups/team-members"

export const teamMemberBillingAccess = defineRole("team-member.billing-access", {
  grantedTo: [teamMembers],
  grants: [can.view([Customer, Invoice]), can.apply(sendReminder)],
})
```

Every member of `team-members` can now view `Customer` and `Invoice` objects and apply the
`sendReminder` action — nothing else.

| Part | Meaning |
| --- | --- |
| `defineRole("team-member.billing-access")` | Names the role |
| `grantedTo: [teamMembers]` | Groups whose members receive the role |
| `grants: [...]` | The capabilities the role gives |
| `can.view([Customer, Invoice])` | Allow viewing those object types |
| `can.apply(sendReminder)` | Allow applying the `sendReminder` action |

A role needs at least one `grantedTo` group and at least one grant. A principal's effective grants
are the union of every role whose `grantedTo` group it belongs to.

## Grants

A grant pairs a capability with the definitions it covers. Three capability builders —
`can.view`, `can.apply`, and `can.run` — resolve to **seven grant kinds**, one per protected target
family.

| Grant kind | Builder | Allows | Targets |
| --- | --- | --- | --- |
| `view:object` | `can.view(...)` | Read objects: `get`, `list`, `query`, telemetry, related events | [Object types](../ontology/object-types.md) |
| `view:dataset` | `can.view(...)` | Read datasets and their versions | [Datasets](../data/datasets.md) |
| `apply:action` | `can.apply(...)` | Request actions | [Actions](../actions/overview.md) |
| `run:workflow` | `can.run(...)` | Start workflows | [Workflows](../workflows/overview.md) |
| `run:sync` | `can.run(...)` | Run syncs | [Syncs](../data/syncs.md) |
| `run:pipeline` | `can.run(...)` | Run pipelines | [Pipelines](../data/pipelines.md) |
| `run:agent` | `can.run(...)` | Run agents and read their threads | [Agents](../agents/overview.md) |

`can.view` resolves to `view:object` or `view:dataset` from the definition you pass; `can.run`
picks between `run:workflow`, `run:sync`, `run:pipeline`, and `run:agent` the same way. Each is
type-checked, so mixing target families in one call does not compile. `can.view(Type)` also covers
the type's subtypes.

### Selecting definitions

Each builder takes one definition, a list, or a breadth selector.

| Want | Write |
| --- | --- |
| One definition | `can.view(Invoice)` |
| Several definitions | `can.view([Customer, Invoice])` |
| Every object type | `can.view(ontology.objects())` |
| Every dataset | `can.view(datasets())` |
| Every action | `can.apply(actions())` |
| Every workflow | `can.run(workflows())` |
| Every sync | `can.run(syncs())` |
| Every pipeline | `can.run(pipelines())` |
| Every agent | `can.run(agents())` |
| Everything but a few | `can.view(ontology.objects().except([Customer]))` |

The breadth selectors are exported from `@sixb/core`: `ontology.objects()`, `datasets()`,
`actions()`, `workflows()`, `syncs()`, and `pipelines()`. Each picks its target family's whole
registered universe and is branded by target, so `can.view(actions())` does not compile.

## Broad grants

Use breadth selectors for roles that should reach most of the system. Add `.except([...])` to keep
a selection broad while carving out a few definitions.

```ts
// security/roles/billing-access.ts
import { actions, can, datasets, defineRole, ontology, workflows } from "@sixb/core"
import { financeAdmins } from "../groups/finance-admins"

export const financeAdminFullAccess = defineRole("finance-admin.full-access", {
  grantedTo: [financeAdmins],
  grants: [
    can.view(ontology.objects()),
    can.view(datasets()),
    can.apply(actions()),
    can.run(workflows()),
  ],
})
```

```ts
// Grant every object type except Customer
can.view(ontology.objects().except([Customer]))
```

## Membership policies

A membership policy says which groups can administer membership, which groups they may administer,
and which operations they may perform. Inviting is one membership operation; managing existing
members uses the same boundary.

```ts
// security/policies/member-administration.ts
import { defineMembershipPolicy } from "@sixb/core"
import { financeAdmins } from "../groups/finance-admins"
import { teamMembers } from "../groups/team-members"

export const memberAdministration = defineMembershipPolicy("member-administration", {
  grantedTo: [financeAdmins],
  scope: [teamMembers],
  can: ["invite"],
})
```

Finance admins can now invite people into `team-members`. A group-less invitation is also allowed
when a caller has the `invite` operation; the resulting user can authenticate but receives no
group-derived grants.

| Option | Meaning |
| --- | --- |
| `grantedTo` | Groups whose members hold the policy |
| `scope` | Groups those members may administer |
| `can` | Membership operations: `invite`, `assignGroups`, `suspend` |

## How principals join groups

Roles and membership policies act on group membership, so principals need a way into a group.

- **Bootstrap** — the auth strategy's `bootstrapGroups` are applied to the first allowed user to
  sign in. This seeds the initial admins.
- **Invitations** — after that, members covered by a membership policy invite teammates into the
  groups that policy allows.

```ts
import { magicLink } from "@sixb/auth-magic-link"
import { financeAdmins } from "./security/groups/finance-admins"

auth: magicLink({
  allowedDomains: ["acme.com"],
  bootstrapUsers: ["admin@acme.com"],
  bootstrapGroups: [financeAdmins],
})
```

The first user to sign in as `admin@acme.com` lands in `finance-admins`, which (via the role
above) can then invite the rest of the team. See [Authentication](authentication.md) for how
strategies and bootstrapping work.

## How grants are enforced

Grants are enforced through a **scoped runtime**. The raw `sixb` instance is privileged — it has
no authorization context and bypasses all grant checks. That is intended for trusted system code
(startup, syncs, projections, workers, tests).

To enforce a principal's grants, derive a scoped runtime with `sixb.as(context)`:

```ts
const scoped = sixb.as(authorizationContext)

await scoped.objects(Invoice).list()   // only if view:object covers Invoice
await scoped.requestAction(input)        // only if apply:action covers it
await scoped.runWorkflow(input)          // only if run:workflow covers it
await scoped.readEvents()                // events whose subject is visible
```

The scoped runtime is **default-deny**: any request without a covering grant throws, and listing
APIs return only the definitions the principal can reach.

### Scoped runtime surface

The scoped runtime exposes only operations whose grants are enforceable end to end. Catalog and
read methods are filtered to what the principal may reach. Writes, links, telemetry appends, and
auth administration stay on the privileged runtime.

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

### Event visibility

There is no standalone "view events" capability. A principal sees a domain event only when it can
view, apply, or run the event's subject:

| Event topic | Visible when |
| --- | --- |
| `objects`, `telemetry` | can view the object type |
| `links` | can view both the source and target object types |
| `actions` | can apply the action (and view its object subject, if any) |
| `rules` | can view the object type the rule fired on |
| `workflows` | can run the workflow |
| `syncs` | can run the sync |
| `pipelines` | can run the pipeline |
| `datasets` | can view the dataset |
| `schedules` | always visible to an authorized reader (no subject grant yet) |

Event filtering is fail-closed: an unmodeled topic is hidden. See [Events](../events/overview.md)
for the event model.

## With the server

The Sixb server does this for you. It resolves the session once per request and routes
authenticated traffic through `sixb.as(context)` automatically, so grants are enforced without
extra wiring. You define groups, roles, and membership policies; the server applies them. See the
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
    invoice.ts
    customer.ts
  actions/
    sendReminder.ts
  security/
    groups/
      team-members.ts
      finance-admins.ts
    roles/
      billing-access.ts
    policies/
      member-administration.ts
  sixb.config.ts
```

`createSixb()` discovers exported definitions from `security/groups/`, `security/roles/`, and
`security/policies/` automatically. See
[Project structure](../fundamentals/project-structure.md). You can also register them explicitly:

```ts
import { createSixb } from "@sixb/core"
import { financeAdmins } from "./security/groups/finance-admins"
import { teamMembers } from "./security/groups/team-members"
import { memberAdministration } from "./security/policies/member-administration"
import { financeAdminFullAccess, teamMemberBillingAccess } from "./security/roles/billing-access"

export const sixb = await createSixb({
  groups: [teamMembers, financeAdmins],
  roles: [teamMemberBillingAccess, financeAdminFullAccess],
  membershipPolicies: [memberAdministration],
})
```

## How to model authorization

Start from the people, not the permissions.

1. List the kinds of user your app has, and turn each into a group.
2. For each group, write one role describing what it can view, apply, and run.
3. Start narrow with explicit grants; widen to a breadth selector or `.except([...])` only when a
   group really needs broad reach.
4. Add a membership policy so the right group can grow the others.
5. Set `bootstrapGroups` so the first sign-in can administer everything else.

Name groups and roles after the people and their access: `team-members`, `finance-admins`,
`team-member.billing-access`, `finance-admin.full-access`.

Grants reference ontology, dataset, action, workflow, sync, and pipeline definitions by id and are
validated against the registered runtime at startup, so a typo or unregistered definition fails
fast.

## Related

- [Authentication](authentication.md) — strategies, sessions, and bootstrapping
- [Auth overview](overview.md) — how authentication and authorization fit together
- [Server overview](../server/overview.md) — per-request enforcement
- [Events](../events/overview.md) — the domain event model
