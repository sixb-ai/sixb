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

[Pipeline](../pipelines/overview.md) steps pass markings on to the columns they compute. Mark the source columns; the datasets a pipeline writes need no markings of their own.

### SQL steps

An output column carries the markings of every input column it depends on:

- its value: the columns its expression reads;
- its rows: the columns that filter, join, group, window, order, or limit the rows. They mark every output column.

```ts
definePipelineStep("large-invoices")
  .inputs({ invoices: rawInvoices })
  .output(largeInvoices)
  .sql(({ invoices }) => `SELECT id, title FROM ${invoices} WHERE amount > 100`)
```

`id` and `title` hold no amount, but the result reveals which invoices exceed 100, so both carry `financial`. A projection from `large_invoices` then reports where the marking comes from, naming each step as `pipeline/step`:

```text
[Sixb] Projection 'large-invoices': property 'Invoice.title' is projected from column 'large_invoices.title', which carries [financial] from 'raw_invoices.amount' through step 'invoices/large-invoices'. Add markings: [financial] to the property.
```

What decided the rows of an input follows every column computed from that input, even one that reads none of its columns: `SELECT count(*) FROM large_invoices`, or a constant selected from it, carries `financial` too.

The lake provider analyzes each SQL step that reads a marked column. Sixb runs this check before the API server serves traffic, when `sixb dev` starts, and in `sixb check` and `sixb lake check`. A query the provider cannot analyze exactly, such as `PIVOT` or `UNPIVOT`, is reported with its step and the construct. A nested field counts as its whole column: reading `meta.plan` carries every marking of `meta`. A lake provider that cannot analyze SQL cannot run SQL steps over marked columns.

Read data only through the step's inputs. A table the query reads by its lake name, or data it reads through a table function that reads files or other tables, such as `read_parquet` or `query_table`, is not tracked, so its markings do not follow.

### TypeScript steps

Sixb cannot see what a `.run()` step computes, so every column it writes carries the markings of every column it reads. Use `pick` to read only the columns the step needs:

```ts
definePipelineStep("score-invoices")
  .inputs({ invoices: rawInvoices.pick("id", "title") })
  .output(scoredInvoices)
  .run(async ({ inputs, output }) => {
    // inputs.invoices holds only id and title
  })
```

`scoredInvoices` carries no `financial`, because the step never reads `amount`. `pick` narrows SQL steps the same way. Only `pick` narrows an input: a copy of a dataset definition with other columns than the registered one is rejected at startup.

### Changing a step

Each dataset version records, when it is written, the source columns each of its columns comes from, through every step upstream. It keeps the markings of the code that produced it: editing a step never declassifies data it already wrote. If a step used to copy `amount` into `title`, the versions it wrote then keep `title` marked, and so do the versions computed from them, however many steps away.

An append or a merge keeps the rows before it, so it also keeps their markings. A history that a step appends to keeps `title` marked after the fix, because it still holds the titles computed from amounts; only a new snapshot replaces them.

Since every version carries its own record, removing older versions from the lake changes no markings. The record grows with the number of source columns behind a dataset, not with its number of versions.

A version written by SQL the lake provider could not analyze carries every marking your project declares, in every column. So does every version computed from it, and every later version of its dataset that keeps its rows, until a new snapshot replaces them.

For versions written before Sixb recorded this lineage, a pipeline version carries every marking your project declares, and a version written by a sync or an ingestion carries the markings its own dataset declares. A version that keeps the rows of such a pipeline version, an append or a merge onto it, carries every marking too, until a new snapshot replaces those rows; for a pipeline that writes snapshots, that is its next run. One case escapes this: a version written before then by a sync or an ingestion, or by a lake schema change, on top of a pipeline version carries only those markings too, and so do the versions that keep its rows. Write a new snapshot of that dataset to replace the rows it kept.

Markings themselves are read from your code. Removing a marking from a source column declassifies that column in every version, past and future.

Reading a dataset version applies that version's markings. A projection refuses a version whose columns carry markings the mapped properties do not declare, and says why. Add the markings to the property, or, if the step's code no longer derives them, rerun its pipeline.

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
- A projected property declares the markings of its column, including the ones the column inherits through pipeline steps.
- A column cannot carry markings when it becomes an object id or a link key, decides a `mostRecent` conflict, or feeds a telemetry projection.
- A SQL step that reads a marked column needs a lake provider that can analyze its query.
- Every marking used by a property, a column, or a clearance must be registered.

Sixb checks these rules at startup, and again for each dataset version a projection reads.

## Trusted code

Actions, workflows, rules, and other [trusted executions](authorization.md#permissions-during-execution) read every property and column. What they return or log to a caller is up to your code.
