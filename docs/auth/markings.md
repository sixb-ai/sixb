# Markings

A role that can view `Invoice` reads every invoice property. Mark the sensitive properties to hide them from roles that are not cleared for them.

A marking classifies data. A clearance lets a role read data with that marking. No grant bypasses a marking.

## Define a marking

Export markings from `security/markings/`. Sixb discovers them automatically.

```ts
// security/markings/financial.ts
import { defineMarking } from "@sixb/core"

export const financial = defineMarking("financial", { label: "Financial" })
```

## Mark a property

```ts
// ontology/invoice.ts
import { defineObjectType, prop } from "@sixb/core"
import { financial } from "../security/markings/financial"

export const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string"),
    prop("amount", "decimal", { markings: [financial] }),
  ],
})
```

A property with several markings requires a clearance for each of them.

## Grant a clearance

Add `clearances` to a [role](authorization.md). A role can carry clearances alone; its members still need a view grant from any role to read the object.

```ts
// security/roles/finance-analyst.ts
import { can, defineRole } from "@sixb/core"
import { Invoice } from "../../ontology/invoice"
import { finance } from "../groups/finance"
import { financial } from "../markings/financial"

export const financeAnalyst = defineRole("finance-analyst", {
  grantedTo: [finance],
  grants: [can.view(Invoice)],
  clearances: [financial],
})
```

## What readers without clearance receive

Objects are still returned. Each marked property is omitted and listed in `redactions`:

```json
{
  "primaryId": "inv-1",
  "objectTypeId": "Invoice",
  "properties": { "id": "inv-1", "title": "July maintenance" },
  "redactions": { "amount": { "reason": "missing_clearance" } }
}
```

An omitted property is absent, never `null`, so `null` keeps meaning an empty value. `redactions` lists every marked property the reader cannot read, whether or not the object has a value for it.

| Request on `amount` without clearance | Result |
| --- | --- |
| Read, list, query, expand, upsert response | Returned without `amount` |
| Project `amount` | Returned without `amount` |
| Filter, sort, facet, or search by `amount` | Rejected with `403` |
| Search without `fields` | Searches the other default text fields |
| Object events | `amount` omitted from `properties` and `propertyChanges` |
| File stored in `amount` | Not found |

[Shared access](shared-access.md) links carry no clearance for now: marked properties are always omitted from shared sessions.

In TypeScript, a marked property is optional when read, even if it is required. Writes still require it.

## Rules

- A primary property, a telemetry property, or a link property cannot be marked.
- A subtype that redefines a marked property must keep its parent's markings.
- Every marking used by a property or a clearance must be registered.

Sixb checks these rules at startup.

## Trusted code

Actions, workflows, rules, and other [trusted executions](authorization.md#permissions-during-execution) read every property. What they return or log to a caller is up to your code.
