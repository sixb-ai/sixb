import type {
  DatasetColumnDefinition,
  DatasetColumnDefinitionOf,
  DatasetColumnNameOf,
  DatasetColumnTypeOf,
  DatasetColumnUnionOf,
  DatasetDefinition,
  DatasetPrimaryKey,
} from "../src"
import { col, defineDataset } from "../src"
import type { DatasetPrimaryKey as DatasetSurfacePrimaryKey } from "../src/datasets"
import type { DatasetPrimaryKey as LakeStorageSurfacePrimaryKey } from "../src/lake-storage"

/**
 * Compile-time contract tests for dataset builder literal inference.
 *
 * This file is intentionally type-only (no runtime `bun:test` cases).
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

// Regression guard: the primary-key contract must remain available from all three type surfaces.
type _datasetSurfacePrimaryKey = Expect<
  Equal<DatasetSurfacePrimaryKey<"id">, DatasetPrimaryKey<"id">>
>
type _lakeStorageSurfacePrimaryKey = Expect<
  Equal<LakeStorageSurfacePrimaryKey<"id">, DatasetPrimaryKey<"id">>
>

const idColumn = col("customer_id", "string")
type _columnName = Expect<Equal<typeof idColumn.name, "customer_id">>
type _columnType = Expect<Equal<typeof idColumn.type, "string">>

const emailColumn = col("email", "string", { nullable: true })
type _nullableColumn = Expect<Equal<typeof emailColumn.nullable, true>>

const _broadColumn: DatasetColumnDefinition = idColumn

const canonicalCustomersDataset = defineDataset("canonical.customers", {
  schema: [
    col("customer_id", "string"),
    col("contact_name", "string"),
    col("annual_revenue", "decimal"),
    col("created_at", "timestamp"),
  ],
  primaryKey: "customer_id",
  partitionBy: ["customer_id"],
  description: "Canonical customers",
})

type _datasetId = Expect<Equal<typeof canonicalCustomersDataset.id, "canonical.customers">>
type _primaryKey = Expect<Equal<typeof canonicalCustomersDataset.primaryKey, "customer_id">>
type _partitionBy = Expect<
  Equal<typeof canonicalCustomersDataset.partitionBy, readonly ["customer_id"]>
>
type _description = Expect<
  Equal<typeof canonicalCustomersDataset.description, "Canonical customers">
>

const _broadPrimaryKey: DatasetPrimaryKey = canonicalCustomersDataset.primaryKey

const customerAddressesDataset = defineDataset("canonical.customer_addresses", {
  schema: [
    col("customer_id", "string"),
    col("address_id", "string", { nullable: false }),
    col("label", "string", { nullable: true }),
  ],
  primaryKey: ["customer_id", "address_id"],
})
type _compositePrimaryKey = Expect<
  Equal<typeof customerAddressesDataset.primaryKey, readonly ["customer_id", "address_id"]>
>

defineDataset("canonical.customers.unknown-key", {
  // Regression guard: removing CheckedDefineDatasetOptions from the overload leaves the
  // following expectation directive unused.
  schema: [col("id", "string")],
  // @ts-expect-error primary keys must reference a declared schema column
  primaryKey: "missing",
})

defineDataset("canonical.customers.nullable-key", {
  schema: [col("id", "string", { nullable: true })],
  // @ts-expect-error primary-key columns must be non-nullable
  primaryKey: "id",
})

defineDataset("canonical.customers.non-string-key", {
  schema: [col("id", "int64")],
  // @ts-expect-error primary-key columns must be strings
  primaryKey: "id",
})

defineDataset("canonical.customers.single-item-composite-key", {
  schema: [col("id", "string")],
  // @ts-expect-error a one-column primary key uses the string shorthand
  primaryKey: ["id"],
})

const copiedCustomersDataset = defineDataset("canonical.customers.copy").derive(
  canonicalCustomersDataset
)
type _copiedDatasetId = Expect<Equal<typeof copiedCustomersDataset.id, "canonical.customers.copy">>
type _copiedColumns = Expect<
  Equal<
    typeof copiedCustomersDataset.schema.columns,
    typeof canonicalCustomersDataset.schema.columns
  >
>

const enrichedCustomersDataset = defineDataset("canonical.customers.enriched").derive(
  canonicalCustomersDataset,
  {
    add: [col("score", "float64")],
  }
)
type _enrichedLastColumn = Expect<
  Equal<(typeof enrichedCustomersDataset.schema.columns)[4]["name"], "score">
>

const customerSummaryDataset = defineDataset("canonical.customer_summary").derive(
  canonicalCustomersDataset,
  {
    pick: ["customer_id", "created_at"],
    add: [col("score", "float64")],
    primaryKey: "customer_id",
    partitionBy: ["customer_id"],
    description: "Customer summary",
  }
)
type _summaryFirstColumn = Expect<
  Equal<(typeof customerSummaryDataset.schema.columns)[0]["name"], "customer_id">
>
type _summarySecondColumn = Expect<
  Equal<(typeof customerSummaryDataset.schema.columns)[1]["name"], "created_at">
>
type _summaryThirdColumn = Expect<
  Equal<(typeof customerSummaryDataset.schema.columns)[2]["name"], "score">
>
type _summaryPrimaryKey = Expect<Equal<typeof customerSummaryDataset.primaryKey, "customer_id">>
type _summaryPartitionBy = Expect<
  Equal<typeof customerSummaryDataset.partitionBy, readonly ["customer_id"]>
>
type _summaryDescription = Expect<
  Equal<typeof customerSummaryDataset.description, "Customer summary">
>

defineDataset("canonical.customers.bad").derive(canonicalCustomersDataset, {
  // @ts-expect-error unknown parent column names should be rejected by derived datasets
  pick: ["missing"],
})

defineDataset("canonical.customers.bad-key").derive(canonicalCustomersDataset, {
  pick: ["customer_id", "created_at"],
  // @ts-expect-error derived primary keys must reference a resulting eligible column
  primaryKey: "created_at",
})

type CustomerColumnNames = DatasetColumnNameOf<typeof canonicalCustomersDataset>
type _columnNames = Expect<
  Equal<CustomerColumnNames, "customer_id" | "contact_name" | "annual_revenue" | "created_at">
>

type SummaryColumnNames = DatasetColumnNameOf<typeof customerSummaryDataset>
type _summaryColumnNames = Expect<Equal<SummaryColumnNames, "customer_id" | "created_at" | "score">>

type CustomerColumnUnion = DatasetColumnUnionOf<typeof canonicalCustomersDataset>
type _columnUnion = Expect<
  Equal<
    CustomerColumnUnion["name"],
    "customer_id" | "contact_name" | "annual_revenue" | "created_at"
  >
>

type RevenueColumn = DatasetColumnDefinitionOf<typeof canonicalCustomersDataset, "annual_revenue">
type _revenueColumnType = Expect<Equal<RevenueColumn["type"], "decimal">>

type _customerIdType = Expect<
  Equal<DatasetColumnTypeOf<typeof canonicalCustomersDataset, "customer_id">, "string">
>
type _revenueType = Expect<
  Equal<DatasetColumnTypeOf<typeof canonicalCustomersDataset, "annual_revenue">, "decimal">
>
type _createdAtType = Expect<
  Equal<DatasetColumnTypeOf<typeof canonicalCustomersDataset, "created_at">, "timestamp">
>
type _summaryScoreType = Expect<
  Equal<DatasetColumnTypeOf<typeof customerSummaryDataset, "score">, "float64">
>

// @ts-expect-error unknown dataset column names should be rejected by column type queries
type _unknownColumnType = DatasetColumnTypeOf<typeof canonicalCustomersDataset, "missing">

const _broadDataset: DatasetDefinition = canonicalCustomersDataset

function defineDynamicDataset(datasetId: string) {
  const dynamicDataset = defineDataset(datasetId, {
    schema: [col("id", "string")],
  })

  type _dynamicDatasetId = Expect<Equal<typeof dynamicDataset.id, string>>

  return dynamicDataset
}

void _broadColumn
void _broadDataset
void _broadPrimaryKey
void defineDynamicDataset
