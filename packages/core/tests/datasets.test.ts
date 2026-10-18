import { describe, expect, test } from "bun:test"
import {
  change,
  col,
  type DatasetDefinition,
  DatasetValidationError,
  defineConnector,
  defineDataset,
  defineObjectType,
  defineSync,
  getDatasetRowValidationError,
  prop,
  RuntimeError,
} from "../src"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const erpDb = defineConnector("erpDb", {
  type: "sql",
  connect() {
    return {}
  },
})

const rawOrdersDataset = defineDataset("raw.erp.orders", {
  schema: [col("orderId", "string"), col("customerId", "string", { nullable: true })],
  partitionBy: ["customerId"],
  description: "Raw ERP orders",
})

const canonicalOrdersDataset = defineDataset("canonical.orders", {
  schema: [col("id", "string")],
})

describe("change", () => {
  test("builds complete-row upserts and keyed deletes", () => {
    const row = { id: "inv_1", status: "open" }
    const key = { id: "inv_2" }

    expect(change.upsert(row)).toEqual({ kind: "upsert", row })
    expect(change.delete(key)).toEqual({ kind: "delete", key })
    expect(change.delete({ id: "42" }, { sequence: 9 })).toEqual({
      kind: "delete",
      key: { id: "42" },
      sequence: 9,
    })
  })
})

describe("defineDataset", () => {
  test("validates source ordering and derives it only when explicitly configured", () => {
    // Regression proof: remove the sequenceBy check in assertDatasetDefinition.
    const schema = [
      col("id", "string"),
      col("revision", "int64"),
      col("optional", "timestamp", { nullable: true }),
    ]
    for (const options of [
      { schema, sequenceBy: "revision" },
      { schema, primaryKey: "id", sequenceBy: "missing" },
      { schema, primaryKey: "id", sequenceBy: "id" },
      { schema, primaryKey: "id", sequenceBy: "optional" },
    ]) {
      expect(() => defineDataset("invalid", options as never)).toThrow("sequenceBy")
    }
    const source = defineDataset("ordered", { schema, primaryKey: "id", sequenceBy: "revision" })
    expect(source.sequenceBy).toBe("revision")
    expect(defineDataset("derived").derive(source).sequenceBy).toBeUndefined()
    expect(
      defineDataset("ordered-derived").derive(source, { primaryKey: "id", sequenceBy: "revision" })
        .sequenceBy
    ).toBe("revision")
  })

  test("snapshots composite primary keys", () => {
    // Regression guard: assigning options.primaryKey directly in createDatasetDefinition makes
    // this test fail after the caller mutates its tuple.
    const primaryKey: ["invoiceId", "lineItemId"] = ["invoiceId", "lineItemId"]
    const lineItems = defineDataset("canonical.line-items", {
      schema: [col("invoiceId", "string"), col("lineItemId", "string")],
      primaryKey,
    })

    primaryKey.reverse()

    expect(lineItems.primaryKey).toEqual(["invoiceId", "lineItemId"])
    expect(lineItems.primaryKey).not.toBe(primaryKey)
  })

  // Regression guard: removing assertDatasetPrimaryKey from assertDatasetDefinition makes these
  // invalid definitions succeed.
  const singleColumnKey = "Dataset primaryKey arrays must contain at least two column names."
  const id = [col("id", "string")]
  const idAndTenant = [col("id", "string"), col("tenantId", "string")]
  test.each([
    [42, "Dataset primaryKey must be a column name or an array", id],
    [[], singleColumnKey, id],
    [["id"], singleColumnKey, id],
    ["", "Dataset primaryKey columns must be non-empty strings.", id],
    [["id", ""], "Dataset primaryKey columns must be non-empty strings.", idAndTenant],
    [["id", 42], "Dataset primaryKey columns must be non-empty strings.", idAndTenant],
    [["id", "id"], "Dataset primaryKey contains duplicate column 'id'.", id],
    ["missing", "Dataset primaryKey column 'missing' is not declared in the schema.", id],
    ["id", "Dataset primaryKey column 'id' must have type 'string'.", [col("id", "int64")]],
    [
      "id",
      "Dataset primaryKey column 'id' must not be nullable.",
      [col("id", "string", { nullable: true })],
    ],
  ] as const)("rejects primary key %j: %s", (primaryKey, message, schema) => {
    expect(() => defineDataset("canonical.invalid-key", { schema, primaryKey } as never)).toThrow(
      message
    )
  })

  test("builds a dataset definition with a wrapped schema", () => {
    expect<DatasetDefinition>(rawOrdersDataset).toEqual({
      kind: "dataset",
      id: "raw.erp.orders",
      schema: {
        columns: [
          { name: "orderId", type: "string" },
          { name: "customerId", type: "string", nullable: true },
        ],
      },
      partitionBy: ["customerId"],
      description: "Raw ERP orders",
    })
  })

  test("derives a dataset with the parent schema, optionally adding columns", () => {
    const activeOrdersDataset = defineDataset("raw.erp.active-orders").derive(rawOrdersDataset)

    expect<DatasetDefinition>(activeOrdersDataset).toEqual({
      kind: "dataset",
      id: "raw.erp.active-orders",
      schema: {
        columns: [
          { name: "orderId", type: "string" },
          { name: "customerId", type: "string", nullable: true },
        ],
      },
    })
    expect(activeOrdersDataset.partitionBy).toBeUndefined()
    expect(activeOrdersDataset.description).toBeUndefined()

    const enrichedOrdersDataset = defineDataset("raw.erp.enriched-orders").derive(
      rawOrdersDataset,
      { add: [col("priority", "int64")] }
    )
    expect(enrichedOrdersDataset.schema.columns).toEqual([
      { name: "orderId", type: "string" },
      { name: "customerId", type: "string", nullable: true },
      { name: "priority", type: "int64" },
    ])
  })

  test("derives a dataset with picked and added columns", () => {
    const orderSummariesDataset = defineDataset("raw.erp.order-summaries").derive(
      rawOrdersDataset,
      {
        pick: ["orderId"],
        add: [col("priority", "int64")],
        primaryKey: "orderId",
        partitionBy: ["orderId"],
        description: "Order summaries",
      }
    )

    expect<DatasetDefinition>(orderSummariesDataset).toEqual({
      kind: "dataset",
      id: "raw.erp.order-summaries",
      schema: {
        columns: [
          { name: "orderId", type: "string" },
          { name: "priority", type: "int64" },
        ],
      },
      primaryKey: "orderId",
      partitionBy: ["orderId"],
      description: "Order summaries",
    })
  })

  test("rejects derived datasets that pick unknown parent columns", () => {
    const derive = () =>
      defineDataset("raw.erp.missing-column").derive(rawOrdersDataset, {
        pick: ["missing"],
      } as never)
    expect(derive).toThrow(DatasetValidationError)
    expect(derive).toThrow(
      "Dataset derive pick column 'missing' is not declared on parent dataset 'raw.erp.orders'."
    )
  })

  test("requires decimal columns to use exact strings", () => {
    const amounts = defineDataset("canonical.amounts", {
      schema: [col("amount", "decimal")],
    })

    expect(getDatasetRowValidationError({ amount: "9007199254740993.01" }, amounts)).toBeNull()
    expect(getDatasetRowValidationError({ amount: 1.1 }, amounts)).toContain(
      "must match type 'decimal'"
    )
  })
})

describe("SixbHost dataset registration", () => {
  test("exposes dataset definitions and lookup by id", () => {
    const sixb = createTestSixb({
      ontology: [Room],
      datasets: [rawOrdersDataset, canonicalOrdersDataset],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.datasets.list().map((dataset) => dataset.id)).toEqual([
      "raw.erp.orders",
      "canonical.orders",
    ])
    expect(sixb.datasets.getById("raw.erp.orders")).toBe(rawOrdersDataset)
    expect(sixb.datasets.getById("missing-dataset")).toBeNull()
  })

  test("rejects duplicate dataset ids", () => {
    expect(() =>
      createTestSixb({
        ontology: [],
        datasets: [
          rawOrdersDataset,
          defineDataset("raw.erp.orders", {
            schema: [col("orderId", "string"), col("customerId", "string", { nullable: true })],
          }),
        ],
        ...createTestRuntimeDeps(),
      })
    ).toThrow("Duplicate dataset id: raw.erp.orders")
  })

  test("rejects syncs that target unknown datasets", () => {
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [])
      .intoDataset(rawOrdersDataset)
    const start = () => createTestSixb({ ontology: [], syncs: [sync], ...createTestRuntimeDeps() })

    expect(start).toThrow(RuntimeError)
    expect(start).toThrow("targets unknown dataset 'raw.erp.orders'")
  })
})
