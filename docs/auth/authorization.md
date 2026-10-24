# Roles & permissions

Groups identify who should have access. Roles give those groups permission to read data, change it, or run specific operations.

Export groups from `security/groups/` and roles from `security/roles/`. Sixb discovers them automatically.

## Define a group

A person or service account can belong to more than one group. Import `defineGroup` from
`@sixb/core/security`: your app's layout can import groups, and that subpath also loads in the
browser.

```ts
// security/groups/finance-team.ts
import { defineGroup } from "@sixb/core/security"

export const financeTeam = defineGroup("finance-team", {
  label: "Finance team",
})
```

## Define a role

A role grants access to one or more groups. This role lets the finance team read invoices and run the project's `markPaid` action.

```ts
// security/roles/finance-access.ts
import { can, defineRole } from "@sixb/core"
import { markPaid } from "../../actions/mark-paid"
import { Invoice } from "../../ontology/invoice"
import { financeTeam } from "../groups/finance-team"

export const financeAccess = defineRole("finance-access", {
  grantedTo: [financeTeam],
  grants: [
    can.view(Invoice),
    can.apply(markPaid),
  ],
})
```

Members receive the combined grants of every role assigned to their groups. To hide sensitive properties from some of them, add [markings](markings.md). Resource access is denied unless granted. Giving someone permission to run an action does not give them permission to edit objects directly.

## Choose permissions

Pass a definition, an array of definitions, or a selector such as `every.object()` to the appropriate builder.

| Builder | Allows |
| --- | --- |
| `can.view(Invoice)` | Read objects, their telemetry, and related events. Also accepts dataset definitions. Add [`.where()`](#grant-only-some-objects) to grant only some objects. |
| `can.edit(Invoice)` | Create, update, delete, and restore objects, and change their relationships. |
| `can.append(Sensor)` | Append telemetry without granting read access. |
| `can.apply(markPaid)` | Request an action. |
| `can.run(invoiceReview)` | Run a workflow, sync, or pipeline. `can.run(agent)` grants access to the built-in agent. |
| `can.run(project.models)` | Call every model in the catalog directly, through the API or `sixb models`. |
| `can.manage(accounting)` | Manage a connector's OAuth accounts. `can.manage(agent.usage)` manages AI limits; `can.manage(agent.memory)` deletes the agent's memory shared by the whole project, which everyone who can run the agent reads and adds to. |
| `can.observe(project.logs)` | Read captured logs. `can.observe(agent.usage)` reads AI usage. |
| `can.observe(project.activity)` | Read the app's [visits and page views](../apps/activity.md). |
| `can.observe(agent.threads)` | Read other users' [agent conversations](../apps/activity.md#read-a-conversation), read-only. It shows everything the agent showed them, whatever the reader's own permissions. |
| `can.view(project.users)` | Read the [member directory](members.md#read-the-member-directory): names, emails, avatars, and status. |
| `can.share(invoiceShare)` | Issue and revoke links from a [Share definition](shared-access.md). |

`agent`, `can`, `every`, and `project` are exported from `@sixb/core`.

Use explicit definitions for focused roles. Selectors are useful for administrators who should also receive access to future definitions:

```ts
import { can, every } from "@sixb/core"
import { Invoice } from "../../ontology/invoice"

const grants = [
  can.view(every.object()),
  can.edit([Invoice]),
  can.run(every.workflow()),
]
```

Use `.except([Definition])` to exclude definitions from a selector. A query is denied when it can return a type the caller cannot view, so excluding a subtype also denies queries that follow or expand a relationship pointing to its parent type.

Object writes require both `can.view(Type)` and `can.edit(Type)`. Relationship writes need edit access to the source and view access to the target. `can.view(Type)` includes its subtypes; edit and telemetry-append grants cover only the types explicitly selected.

## Grant only some objects

Add `.where()` to `can.view(Type)` to grant only the objects that match. It takes the same
predicates as a [query](../objects/querying.md#filter-objects), including
[`currentUser()`](../objects/querying.md#match-the-reading-user):

```ts
// security/roles/staff-access.ts
import { can, currentUser, defineRole } from "@sixb/core"
import { Invoice } from "../../ontology/invoice"
import { Note } from "../../ontology/note"
import { staff } from "../groups/staff"

export const staffAccess = defineRole("staff-access", {
  grantedTo: [staff],
  grants: [
    can.view(Invoice).where((invoice) => invoice.p.status.neq("draft")),
    can.view(Note).where((note) => note.p.owner.eq(currentUser())),
  ],
})
```

A member sees an object when any of their roles shows it: someone in both `staff` and
`finance-team` sees every invoice, because [`finance-access`](#define-a-role) views them all. The
condition covers subtypes too, and [markings](markings.md) still redact what it shows. In a
condition, `currentUser()` is the member the role applies to. For a service account it matches no
one, even an agent's account working for a user.

A hidden object behaves like a missing one, everywhere it could appear:

| Surface | With an object the reader cannot see |
| --- | --- |
| Get, list, query, count, facets, search | Missing: `get` returns `null`, HTTP answers `404`, pages and totals leave it out. |
| Links and expansions | Never reach it. |
| Events | Not delivered. An update that hides an object sends that reader nothing, so their copy stays stale until they read it again. Deleting an object they saw sends them its deletion and the links it removed. |
| Telemetry and files | Return nothing, as for a missing object. |
| Action requests | A hidden subject or `ref()` parameter is not found (`404`). |
| Action runs and rule matches | Shown while their object is visible. On such a type, list them for one object: a listing that names no object leaves them out. |
| Writes with `can.edit` | Deleting or linking it fails as for a missing object. Writing its id, or a [unique](../ontology/properties.md#unique-values) value it holds, fails as taken (`409`): the writer learns the value exists. |

Limits:

- A condition reads the type's own properties, never its links. Each property it reads needs
  `query: { searchable: true, filterable: true }`.
- It cannot read a marked property, and cannot order text (`lt`, `gte`…): use `eq`, `neq`, `in` or
  `contains`. Sixb rejects these at startup, and checks each condition against your object storage.
- A reader who sees a type only through a condition cannot restore objects of that type or see its
  projection runs. They can issue a [share link](shared-access.md) on an object they see, but not
  one whose selected links reach that type.
- Actions and workflows run [trusted](#permissions-during-execution): conditions do not apply in
  their handlers, and an action can create an object its requester cannot see.

## Choose who sees the app's sections

Every signed-in member opens the project's app. Roles decide what each member can read and do in
it. To show the app's Data, Observability, Ontology and Settings pages only to some groups, set the
app's [`visibility`](../apps/overview.md#choose-who-sees-a-section). Visibility only hides screens:
the API still checks each request against the caller's grants.

## Permissions during execution

Requests from an app or API are checked against the caller's grants. An action or workflow, once admitted, runs your registered server code with trusted access to the project. It does not inherit the caller's resource restrictions inside its handlers.

Treat permission to run a command as permission to perform the changes that command allows. Validate its inputs and enforce any record-specific business restrictions in your code.

Agents, and the project tools they call, use the agent's execution permissions. See [AI](../models/overview.md#control-access), [tools](../models/tools-and-authorization.md#use-project-data-in-a-tool), and [AI workflow tasks](../workflows/overview.md#add-an-ai-task).

Use [membership policies](members.md) to control who can assign groups, and [permission tests](../testing/overview.md#test-permissions) to check allowed and denied access.
