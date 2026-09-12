# Datasets

A dataset is a typed table of rows. Reach for one whenever you have table-shaped data: raw rows pulled from an external system, cleaned rows produced by a pipeline, or rows a projection turns into objects.

A dataset is a contract: the table's name, its columns, each column's type, and which columns may be `null`. Define it once and [syncs](./syncs.md), [pipelines](./pipelines.md), [projections](./projections.md), and storage all point at the same shape.

If an [ontology](../ontology/overview.md) is your object model, a dataset is your table model.

## Define a dataset

A dataset has a stable id and a `schema` of columns. Build each column with `col(name, type)`.

```ts
import { col, defineDataset } from "@sixb/core"

export const rawInvoicesDataset = defineDataset("erp.invoices", {
  schema: [
    col("id", "string"),
    col("number", "string"),
    col("amount", "decimal"),
    col("currency", "string"),
    col("status", "string"),
    col("issuedAt", "timestamp"),
    col("dueDate", "date"),
    col("customer_id", "string"),
    col("project_id", "string"),
  ],
  primaryKey: "id",
  description: "Raw invoice rows from the ERP.",
})
```

The id `erp.invoices` is the name every other part of the project references.

### `defineDataset` options

| Option | Type | Description |
| --- | --- | --- |
| `schema` | `col(...)[]` | Required. The ordered list of column definitions. |
| `primaryKey` | `string \| string[]` | Optional. One key column or an ordered composite key. |
| `sequenceBy` | `string` | Optional. Non-nullable `timestamp` or `int64` column used to order source changes; requires a primary key. |
| `partitionBy` | `string[]` | Optional. Logical partition columns; each name must exist in `schema`. |
| `description` | `string` | Optional. Human-readable description. |

### Primary keys

Use one non-nullable string column for a single-column key, or two or more for a composite key:

```ts
export const invoices = defineDataset("erp.invoices", {
  schema: [col("id", "string"), col("status", "string")],
  primaryKey: "id",
})

export const invoiceLines = defineDataset("erp.invoice_lines", {
  schema: [
    col("invoiceId", "string"),
    col("lineItemId", "string"),
    col("description", "string"),
  ],
  primaryKey: ["invoiceId", "lineItemId"],
})
```

V1 primary keys have these constraints:

- Every key column must exist in the schema, have type `string`, and be non-nullable.
- Composite keys contain at least two unique columns. Column order is significant.
- A key cannot be added, removed, changed, or reordered after the dataset is created.
- Rows must be unique by key, and a row's key is immutable. Merge-capable lake providers enforce
  uniqueness for keyed snapshots, appends, transforms, and merges.

Use a keyed dataset with a [merge sync](./syncs.md#sync-modes) when the source exposes ordered row
changes and the dataset should stay current without replacing every row on each run.

### Source ordering

Use `sequenceBy` to keep the newest source record when changes arrive out of order:

```ts
export const people = defineDataset("crm.people", {
  schema: [col("id", "string"), col("name", "string"), col("updatedAt", "timestamp")],
  primaryKey: "id",
  sequenceBy: "updatedAt",
})
```

Use the **source's** revision or timestamp, not fetch/receipt time. Submit complete rows or sequenced deletes:

```ts
import { change } from "@sixb/core"

change.upsert({ id: "42", name: "Sam", updatedAt: "2026-09-09T10:00:00.123Z" })
change.delete({ id: "42" }, { sequence: "2026-09-09T10:01:00.000Z" })
```

#### Merge behavior

| Incoming change | Result |
| --- | --- |
| Newer sequence | Applies |
| Older sequence | Ignored |
| Equal sequence, identical content | Unchanged |
| Equal sequence, different content or upsert/delete tie | Entire merge fails |
| Delete v9 → upsert v8 → upsert v10 | Stays deleted at v8; restored at v10 |

Repeated keys are processed in submission order. Deletions retain durable ordering state, even for
absent keys; new deletion state creates a version without requiring a visible row change.

#### Sequence values

| Column type | Accepted values |
| --- | --- |
| `int64` | Signed 64-bit integers. Use decimal strings outside JavaScript's safe integer range. |
| `timestamp` | Valid `Date` or ISO timestamp with `Z`/`±HH:MM` and at most 3 fractional digits. Equivalent instants compare equally. |

#### V1 constraints

- **Snapshot syncs reconcile.** Returned rows become ordered upserts; omitted keys stay. Deletion requires a sequenced delete.
- **Empty snapshots initialize.** A first successful snapshot creates an addressable version even
  with no rows. Later empty snapshots reuse the existing version and retain its rows.
- **Bounded retries.** Sequenced writes retry known concurrency conflicts up to 3 total attempts, reusing staged changes without re-fetching. Explicit version guards stay strict.
- **Provider writes use merges.** Direct snapshot/append sessions and SQL-transform writes to sequenced datasets are rejected.
- **Immutable configuration.** Create a new dataset and backfill to adopt or change `sequenceBy`.
- **Explicit derivation.** Derived datasets must declare their own `sequenceBy` and primary key.

For content equality, object-key order is ignored; array order matters. Nullable columns treat
omitted, `undefined`, and `null` equally. Integer, decimal, date, and timestamp columns use canonical values.
On a sequenced dataset, **every timestamp column** must use a valid `Date` or timezone-explicit
ISO string with at most 3 fractional digits, including columns other than `sequenceBy`. Higher
precision is rejected before staging so content comparison never silently discards it.

### `col` options

```ts
col("amount", "decimal")
col("project_id", "string", { nullable: true })
```

Pass `{ nullable: true }` when a column may be missing or `null`. Use the `json` type to keep an intentionally unstructured payload:

```ts
col("raw", "json", { nullable: true })
```

## Column types

| Type | Accepts |
| --- | --- |
| `string` | a string |
| `boolean` | a boolean |
| `int64` | an integer, or an integer string |
| `float64` | a finite number |
| `decimal` | an exact decimal string |
| `date` | a `Date`, or a `YYYY-MM-DD` string |
| `timestamp` | a `Date`, or a parseable date string |
| `json` | any JSON value |
| `fileRef` | a [file reference](../infrastructure/overview.md) |

Decimal columns reject JavaScript numbers because their exact source value may already have lost
precision. Keep decimals as strings from the source, or construct typed values with `decimal("...")`
or `decimal(anExactBigInt)`. Do not convert a `number` with `String(...)` and assume precision is
restored.

## Use a dataset

A dataset on its own is just a shape. The pieces that produce and consume rows reference it.

A [sync](./syncs.md) reads from a [connector](./connectors.md) and writes into one dataset. It does not repeat the schema; it points at the definition:

```ts
import { defineSync } from "@sixb/core"
import { acmeErpConnector } from "../connectors/acme-erp"
import { rawInvoicesDataset } from "../datasets/erp"

export const syncErpInvoices = defineSync("sync-erp-invoices")
  .from(acmeErpConnector)
  .read((client) => client.listInvoices())
  .intoDataset(rawInvoicesDataset)
```

A [pipeline](./pipelines.md) reads datasets and writes new ones, keeping raw source rows separate from clean, app-ready rows:

```ts
import type { DatasetRow } from "@sixb/core"
import {
  col,
  defineDataset,
  definePipeline,
  definePipelineStep,
  defineSchedule,
  events,
} from "@sixb/core"
import { rawInvoicesDataset } from "../datasets/erp"

export const paidInvoicesDataset = defineDataset("invoices.paid", {
  schema: [
    col("id", "string"),
    col("amount", "decimal"),
    col("currency", "string"),
    col("customer_id", "string"),
  ],
})

async function* paidInvoices(rows: AsyncIterable<DatasetRow>) {
  for await (const row of rows) {
    if (row.status === "paid") {
      yield {
        id: row.id,
        amount: row.amount,
        currency: row.currency,
        customer_id: row.customer_id,
      }
    }
  }
}

export const paidInvoicesStep = definePipelineStep("paid-invoices")
  .inputs({ invoices: rawInvoicesDataset })
  .output(paidInvoicesDataset)
  .run(async ({ inputs, output }) => {
    await output.writeRows(paidInvoices(inputs.invoices.readRows()))
  })

export const rawInvoicesUpdated = defineSchedule("raw-invoices-updated").on(
  events.dataset(rawInvoicesDataset).updated()
)

export const paidInvoicesPipeline = definePipeline("paid-invoices")
  .when(rawInvoicesUpdated)
  .then(paidInvoicesStep)
```

Then a [projection](./projections.md) maps the clean rows onto `Invoice` objects.

## Derive a dataset

Use `.derive(parent)` to copy a parent's schema, then narrow it with `pick` or extend it with `add`.

```ts
import { col, defineDataset } from "@sixb/core"
import { rawInvoicesDataset } from "./erp"

// Copy the full parent schema
export const invoicesArchive = defineDataset("invoices.archive").derive(rawInvoicesDataset)

// Narrow to a subset of columns and add new ones
export const invoicesSummary = defineDataset("invoices.summary").derive(rawInvoicesDataset, {
  pick: ["id", "amount", "currency", "customer_id"],
  add: [col("settled_at", "timestamp")],
})
```

| `derive` option | Type | Description |
| --- | --- | --- |
| `pick` | `string[]` | Keep only these parent columns. Each name must exist on the parent. |
| `add` | `col(...)[]` | Append these columns after the kept ones. |
| `primaryKey` | `string \| string[]` | Optional key over the resulting columns. |
| `sequenceBy` | `string` | Optional ordering column over the resulting columns; requires an explicit primary key. |
| `partitionBy` | `string[]` | Optional partition columns for the derived dataset. |
| `description` | `string` | Optional description for the derived dataset. |

Derived datasets do not inherit their parent's primary key. Declare `primaryKey` explicitly when
the derived rows preserve the same identity contract.

## Dataset vs ontology

Datasets and ontology types solve different problems.

| Use | Choose |
| --- | --- |
| Raw source rows, cleaned table rows | Dataset |
| Objects users interact with | [Ontology](../ontology/overview.md) |
| Relationships between objects | [Ontology links](../ontology/links.md) |

The usual flow: source data lands in a raw dataset, pipelines shape it into a clean dataset, and projections turn it into ontology objects.

## Register datasets

Export dataset definitions from `datasets/` and `createSixb()` discovers them automatically.

```txt
your-project/
  datasets/
    erp.ts
  syncs/
    erp.ts
  pipelines/
    invoices.ts
  sixb.config.ts
```

You can also register them explicitly:

```ts
import { createSixb } from "@sixb/core"
import { rawInvoicesDataset } from "./datasets/erp"

export const sixb = await createSixb({
  datasets: [rawInvoicesDataset],
})
```

## Row validation

Every row written to a dataset is validated against its schema:

- A row must be a plain object and may not contain unknown columns.
- Each value must match its column's declared type.
- A non-nullable column may not be missing, `undefined`, or `null`.
- A nullable column may be omitted or set to `null`.

## Modeling tips

- Start from the source shape. Keep source column names (`account_mgr_id`, `dept_id`) on raw datasets — it makes debugging easier.
- Mark uncertain fields `nullable`. Reserve `json` for payloads you intentionally keep unstructured.
- Name datasets by layer and source: `erp.invoices`, `erp.customers` for raw, `invoices.paid` for derived.
- Model money as `amount` + `currency`, never as a unit type.
- Shape clean datasets with pipelines rather than overloading the raw dataset.

## Related

- [Connectors](./connectors.md) — external systems datasets read from
- [Syncs](./syncs.md) — pull rows into a dataset
- [Pipelines](./pipelines.md) — transform one dataset into another
- [Projections](./projections.md) — turn rows into ontology objects
