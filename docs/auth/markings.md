# Markings

A role that can view `Invoice` reads every invoice property, and a role that can view a dataset reads every column. Mark the sensitive properties and columns to hide them from roles that are not cleared for them.

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

## Mark a dataset column

Mark the data where it enters Sixb: on the dataset a sync or an ingestion writes.

```ts
// datasets/raw-invoices.ts
import { col, defineDataset } from "@sixb/core"
import { financial } from "../security/markings/financial"

export const rawInvoices = defineDataset("raw_invoices", {
  schema: [
    col("id", "string"),
    col("title", "string"),
    col("amount", "decimal", { markings: [financial] }),
  ],
  primaryKey: "id",
})
```

The ontology is what your app reads, so a [projected](../projections/overview.md) property declares the markings of its column. Sixb checks it at startup:

```text
[Sixb] Projection 'invoices': property 'Invoice.amount' is projected from column 'raw_invoices.amount', which carries [financial]. Add markings: [financial] to the property.
```

## Grant a clearance

Add `clearances` to a [role](authorization.md). A role can carry clearances alone; its members still need a view grant from any role to read the object.

```ts
// security/roles/finance-analyst.ts
import { can, defineRole } from "@sixb/core"
import { rawInvoices } from "../../datasets/raw-invoices"
import { Invoice } from "../../ontology/invoice"
import { finance } from "../groups/finance"
import { financial } from "../markings/financial"

export const financeAnalyst = defineRole("finance-analyst", {
  grantedTo: [finance],
  grants: [can.view(Invoice), can.view(rawInvoices)],
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

Dataset rows follow the same contract. Marked columns are left out of `columns` and of every row, even when requested:

```json
{
  "columns": ["id", "title"],
  "rows": [{ "id": "inv-1", "title": "July maintenance" }],
  "redactions": { "amount": { "reason": "missing_clearance" } }
}
```

[Shared access](shared-access.md) links carry no clearance for now: marked properties are always omitted from shared sessions.

In TypeScript, a marked property is optional when read, even if it is required. Writes still require it.

## Rules

- A primary property, a telemetry property, or a link property cannot be marked.
- A subtype that redefines a marked property must keep its parent's markings.
- A projected property declares the markings of its column.
- A column cannot be marked when it becomes an object id or a link key, decides a `mostRecent` conflict, or feeds a telemetry projection.
- Pipeline steps cannot read marked columns yet. A step may mark the columns it produces.
- Every marking used by a property, a column, or a clearance must be registered.

Sixb checks these rules at startup.

## Trusted code

Actions, workflows, rules, and other [trusted executions](authorization.md#permissions-during-execution) read every property and column. What they return or log to a caller is up to your code.
