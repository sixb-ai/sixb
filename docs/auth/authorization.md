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
| `can.view(Invoice)` | Read objects, their telemetry, and related events. Also accepts dataset definitions. |
| `can.edit(Invoice)` | Create, update, delete, and restore objects, and change their relationships. |
| `can.append(Sensor)` | Append telemetry without granting read access. |
| `can.apply(markPaid)` | Request an action. |
| `can.run(invoiceReview)` | Run a workflow, sync, or pipeline. `can.run(agent)` grants access to the built-in agent. |
| `can.manage(accounting)` | Manage a connector's OAuth accounts. `can.manage(agent.usage)` manages AI limits. |
| `can.observe("logs")` | Read captured logs. `can.observe(agent.usage)` reads AI usage. |
| `can.share(invoiceShare)` | Issue and revoke links from a [Share definition](shared-access.md). |

`agent`, `can`, and `every` are exported from `@sixb/core`.

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

## Choose who sees the app's sections

Every signed-in member opens the project's app. Roles decide what each member can read and do in
it. To show the app's Data, Observability, Ontology and Settings pages only to some groups, set the
app's [`visibility`](../apps/overview.md#choose-who-sees-a-section). Visibility only hides screens:
the API still checks each request against the caller's grants.

## Permissions during execution

Requests from an app or API are checked against the caller's grants. An action or workflow, once admitted, runs your registered server code with trusted access to the project. It does not inherit the caller's resource restrictions inside its handlers.

Treat permission to run a command as permission to perform the changes that command allows. Validate its inputs and enforce any record-specific business restrictions in your code. Ordinary object grants cover a whole type, not selected rows.

Agents, and the project tools they call, use the agent's execution permissions. See [AI](../models/overview.md#control-access), [tools](../models/tools-and-authorization.md#use-project-data-in-a-tool), and [AI workflow tasks](../workflows/overview.md#add-an-ai-task).

Use [membership policies](members.md) to control who can assign groups, and [permission tests](../testing/overview.md#test-permissions) to check allowed and denied access.
