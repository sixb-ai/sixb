# Datasets

A dataset defines a table: its columns, accepted values, and optional keys. [Syncs](../syncs/overview.md)
write source rows, [pipelines](../pipelines/overview.md) transform them, and [projections](../projections/overview.md)
turn them into objects.

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

## Primary keys

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

Primary-key constraints:

- Every key column must exist in the schema, have type `string`, and be non-nullable.
- Composite keys contain at least two unique columns. Column order is significant.
- A key cannot be added, removed, changed, or reordered after the dataset is created.
- Rows must be unique by key, and a row's key is immutable. Merge-capable lake providers enforce
  uniqueness for keyed snapshots, appends, transforms, and merges.

For out-of-order source updates, add `sequenceBy`. See [Source ordering](source-ordering.md#source-ordering) for the definition and merge rules.

## Nullable columns

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

## File location

Export definitions from `datasets/`. See [Project structure](../fundamentals/project-structure.md) for discovery rules.

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

- [Connectors](../connectors/overview.md) — external systems datasets read from
- [Syncs](../syncs/overview.md) — pull rows into a dataset
- [Pipelines](../pipelines/overview.md) — transform one dataset into another
- [Projections](../projections/overview.md) — turn rows into ontology objects
