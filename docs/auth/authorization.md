# Roles & permissions

Groups identify who should have access. Roles give those groups permission to read data, change it, or run specific operations.

Export groups from `security/groups/` and roles from `security/roles/`. Sixb discovers them automatically.

## Define a group

A person or service account can belong to more than one group.

```ts
// security/groups/finance-team.ts
import { defineGroup } from "@sixb/core"

export const financeTeam = defineGroup("finance-team", {
  label: "Finance team",
})
```

## Define a role

A role grants access to one or more groups. This role lets the finance team open the custom app, read invoices, and run the project's `markPaid` action.

```ts
// security/roles/finance-access.ts
import { applications, can, defineRole } from "@sixb/core"
import { markPaid } from "../../actions/mark-paid"
import { Invoice } from "../../ontology/invoice"
import { financeTeam } from "../groups/finance-team"

export const financeAccess = defineRole("finance-access", {
  grantedTo: [financeTeam],
  grants: [
    can.access(applications.app),
    can.view(Invoice),
    can.apply(markPaid),
  ],
})
```

Members receive the combined grants of every role assigned to their groups. Resource access is denied unless granted. Giving someone permission to run an action does not give them permission to edit objects directly.

## Choose permissions

Pass a definition, an array of definitions, or a selector such as `every.object()` to the appropriate builder.

| Builder | Allows |
| --- | --- |
| `can.access(applications.app)` | Open the custom app. Use `applications.atlas` for Atlas. |
| `can.view(Invoice)` | Read objects, their telemetry, and related events. Also accepts dataset definitions. |
| `can.edit(Invoice)` | Create, update, delete, and restore objects, and change their relationships. |
| `can.append(Sensor)` | Append telemetry without granting read access. |
| `can.apply(markPaid)` | Request an action. |
| `can.run(invoiceReview)` | Run a workflow, sync, or pipeline. `can.run(agent)` grants access to the built-in agent. |
| `can.manage(accounting)` | Manage a connector's OAuth accounts. `can.manage(agent.usage)` manages AI limits. |
| `can.observe("logs")` | Read captured logs. `can.observe(agent.usage)` reads AI usage. |
| `can.share(invoiceShare)` | Issue and revoke links from a [Share definition](shared-access.md). |

`applications`, `agent`, `can`, and `every` are exported from `@sixb/core`.

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

Use `.except([Definition])` to exclude definitions from a selector.

Object writes require both `can.view(Type)` and `can.edit(Type)`. Relationship writes need edit access to the source and view access to the target. `can.view(Type)` includes its subtypes; edit and telemetry-append grants cover only the types explicitly selected.

## Control application access

To restrict Atlas to administrators, grant it to the administrator group defined during [authentication setup](authentication.md#set-up-the-first-administrator):

```ts
// security/roles/finance-admin-access.ts
import { applications, can, defineRole } from "@sixb/core"
import { Invoice } from "../../ontology/invoice"
import { financeAdmins } from "../groups/finance-admins"

export const financeAdminAccess = defineRole("finance-admin-access", {
  grantedTo: [financeAdmins],
  grants: [
    can.access(applications.atlas),
    can.view(Invoice),
    can.edit(Invoice),
    can.observe("logs"),
  ],
})
```

**Application access is unrestricted for signed-in users until a role grants that application.** Once a role grants Atlas or the custom app, only groups with that application's grant may open it. This does not grant access to its data; resource permissions still apply.

## Permissions during execution

Requests from an app or API are checked against the caller's grants. An action or workflow, once admitted, runs your registered server code with trusted access to the project. It does not inherit the caller's resource restrictions inside its handlers.

Treat permission to run a command as permission to perform the changes that command allows. Validate its inputs and enforce any record-specific business restrictions in your code. Ordinary object grants cover a whole type, not selected rows.

Agents use their own execution permissions. See [AI](../models/overview.md#built-in-agent) and [AI workflow tasks](../workflows/overview.md#add-an-ai-task).

Use [membership policies](members.md) to control who can assign groups, and [permission tests](../testing/overview.md#test-permissions) to check allowed and denied access.
