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

## Markings through pipelines

Mark the source columns: the datasets [pipelines](../pipelines/overview.md) compute from them, and the objects projected from those, carry their markings.

### SQL steps

An output column carries the markings of every column its value reads, and of every column that decides its rows: filters, joins, grouping, windows, ordering, and limits.

```ts
definePipelineStep("large-invoices")
  .inputs({ invoices: rawInvoices })
  .output(largeInvoices)
  .sql(({ invoices }) => `SELECT id, title FROM ${invoices} WHERE amount > 100`)
```

`id` holds no amount, but the rows reveal which invoices exceed 100, so `id` and `title` carry `financial`, and readers without it cannot read the rows of `large_invoices` at all. A `count(*)` or a constant selected from a filtered input carries what decided its rows too.

Read data only through the step's inputs. A table read by its lake name, or through a table function that reads files or tables (`read_parquet`, `query_table`), is not tracked. A query Sixb cannot analyze exactly, such as `PIVOT`, is rejected.

### TypeScript steps

Sixb cannot see what a `.run()` step computes, so every column it writes carries the markings of every column it reads. [Pick](../pipelines/overview.md#read-only-some-columns) only the columns the step needs:

```ts
.inputs({ invoices: rawInvoices.pick("id", "title") })
```

### Projected properties

A projected property declares the markings its column inherits. Sixb names the path a marking took:

```text
[Sixb] Projection 'large-invoices': property 'Invoice.title' is projected from column 'large_invoices.title', which carries [financial] from 'raw_invoices.amount' through step 'invoices/large-invoices'. Add markings: [financial] to the property.
```

Sixb checks this before the API server serves traffic, when `sixb dev` starts, and in `sixb check` and `sixb lake check`.

### Changing a step

Editing a step never declassifies data it already wrote. Each dataset version keeps the markings of the code that wrote it, and so do the versions computed from it. An append or a merge keeps the markings of the rows before it until a snapshot replaces them.

Objects keep the markings of the version their projection applied. Say `title` was computed from `amount`, and you fix the step and remove `financial` from `Invoice.title`: readers without `financial` keep receiving `title` redacted until the pipeline runs again and the projection applies the new version. A projection you remove keeps what it wrote unreadable to readers lacking the markings of the version it applied. Every server sees a newly applied version within seconds.

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
| Events of a type or link the reader cannot read | Not delivered |
| File stored in `amount` | Not found |

Dataset rows follow the same contract. Marked columns are left out of `columns` and of every row, even when requested. A version whose rows were selected by a column the reader is not cleared for is refused with `403`, and its row count is left out of the dataset's versions:

```json
{
  "columns": ["id", "title"],
  "rows": [{ "id": "inv-1", "title": "July maintenance" }],
  "redactions": { "amount": { "reason": "missing_clearance" } }
}
```

[Shared access](shared-access.md) links carry no clearance for now: marked properties are always omitted from shared sessions.

Events are redacted with the markings in force when they are read. An object event a projection emitted also keeps the markings of the dataset version it came from; the `before` values of its `propertyChanges` came from the previous version, but are read under that one.

In TypeScript, a marked property is optional when read, even if it is required. Writes still require it. A property that keeps a marking from its applied version can be absent too.

## Rules

- A primary property, a telemetry property, or a link property cannot be marked.
- A subtype that redefines a marked property must keep its parent's markings.
- A projected property declares the markings of its column, including the ones it inherits through pipeline steps.
- A column cannot carry markings when it becomes an object id or a link key, decides a `mostRecent` conflict, or feeds a telemetry projection.
- A SQL step that reads a marked column needs a lake provider that can analyze its query.
- Every marking used by a property, a column, or a clearance must be registered.

Sixb checks these rules at startup.

## Trusted code

Actions, workflows, rules, and other [trusted executions](authorization.md#permissions-during-execution) read every property and column. What they return or log to a caller is up to your code.
