import { describe, expect, test } from "bun:test"
import {
  change,
  col,
  DatasetValidationError,
  defineConnector,
  defineDataset,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineSync,
  getDatasetRowValidationError,
  prop,
  RuntimeError,
  Sixb,
} from "../src"
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
  })
})

describe("defineDataset", () => {
  test("builds single and composite primary keys", () => {
    const customers = defineDataset("canonical.customers", {
      schema: [col("id", "string")],
      primaryKey: "id",
    })
    const lineItems = defineDataset("canonical.line-items", {
      schema: [col("invoiceId", "string"), col("lineItemId", "string", { nullable: false })],
      primaryKey: ["invoiceId", "lineItemId"],
    })

    expect(customers.primaryKey).toBe("id")
    expect(lineItems.primaryKey).toEqual(["invoiceId", "lineItemId"])
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

  test("validates primary-key shape", () => {
    // Regression guard: removing assertDatasetPrimaryKey from assertDatasetDefinition makes these
    // invalid definitions succeed.
    expect(() =>
      defineDataset("canonical.invalid-key", {
        schema: [col("id", "string")],
        primaryKey: 42,
      } as never)
    ).toThrow("Dataset primaryKey must be a column name or an array of at least two column names.")
    expect(() =>
      defineDataset("canonical.invalid-key", {
        schema: [col("id", "string")],
        primaryKey: [],
      } as never)
    ).toThrow(
      "Dataset primaryKey arrays must contain at least two column names. Use a string for a single-column key."
    )
    expect(() =>
      defineDataset("canonical.invalid-key", {
        schema: [col("id", "string")],
        primaryKey: "",
      } as never)
    ).toThrow("Dataset primaryKey columns must be non-empty strings.")
    expect(() =>
      defineDataset("canonical.invalid-key", {
        schema: [col("id", "string")],
        primaryKey: ["id"],
      } as never)
    ).toThrow(
      "Dataset primaryKey arrays must contain at least two column names. Use a string for a single-column key."
    )
    expect(() =>
      defineDataset("canonical.invalid-key", {
        schema: [col("id", "string"), col("tenantId", "string")],
        primaryKey: ["id", ""],
      } as never)
    ).toThrow("Dataset primaryKey columns must be non-empty strings.")
    expect(() =>
      defineDataset("canonical.invalid-key", {
        schema: [col("id", "string"), col("tenantId", "string")],
        primaryKey: ["id", 42],
      } as never)
    ).toThrow("Dataset primaryKey columns must be non-empty strings.")
  })

  test("rejects duplicate primary-key columns", () => {
    expect(() =>
      defineDataset("canonical.invalid-key", {
        schema: [col("id", "string")],
        primaryKey: ["id", "id"],
      } as never)
    ).toThrow("Dataset primaryKey contains duplicate column 'id'.")
  })

  test("requires primary-key columns to exist in the schema", () => {
    expect(() =>
      defineDataset("canonical.invalid-key", {
        schema: [col("id", "string")],
        primaryKey: "missing",
      } as never)
    ).toThrow("Dataset primaryKey column 'missing' is not declared in the schema.")
  })

  test("requires primary-key columns to be strings", () => {
    expect(() =>
      defineDataset("canonical.invalid-key", {
        schema: [col("id", "int64")],
        primaryKey: "id",
      } as never)
    ).toThrow("Dataset primaryKey column 'id' must have type 'string'.")
  })

  test("requires primary-key columns to be non-nullable", () => {
    expect(() =>
      defineDataset("canonical.invalid-key", {
        schema: [col("id", "string", { nullable: true })],
        primaryKey: "id",
      } as never)
    ).toThrow("Dataset primaryKey column 'id' must not be nullable.")
  })

  test("builds a dataset definition with a wrapped schema", () => {
    expect(rawOrdersDataset).toEqual({
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

  test("derives a dataset with the parent schema", () => {
    const activeOrdersDataset = defineDataset("raw.erp.active-orders").derive(rawOrdersDataset)

    expect(activeOrdersDataset).toEqual({
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

    expect(orderSummariesDataset).toEqual({
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

  test("derives a dataset with the parent schema and added columns", () => {
    const enrichedOrdersDataset = defineDataset("raw.erp.enriched-orders").derive(
      rawOrdersDataset,
      {
        add: [col("priority", "int64")],
      }
    )

    expect(enrichedOrdersDataset.schema.columns).toEqual([
      { name: "orderId", type: "string" },
      { name: "customerId", type: "string", nullable: true },
      { name: "priority", type: "int64" },
    ])
  })

  test("rejects derived datasets that pick unknown parent columns", () => {
    expect(() =>
      defineDataset("raw.erp.missing-column").derive(rawOrdersDataset, {
        pick: ["missing"],
      } as never)
    ).toThrow(DatasetValidationError)
    expect(() =>
      defineDataset("raw.erp.missing-column").derive(rawOrdersDataset, {
        pick: ["missing"],
      } as never)
    ).toThrow(
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

describe("Sixb dataset registration", () => {
  test("exposes dataset definitions and lookup by id", () => {
    const sixb = new Sixb({
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
    expect(
      () =>
        new Sixb<readonly []>({
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

    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [],
          syncs: [sync],
          ...createTestRuntimeDeps(),
        })
    ).toThrow(RuntimeError)
    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [],
          syncs: [sync],
          ...createTestRuntimeDeps(),
        })
    ).toThrow("targets unknown dataset 'raw.erp.orders'")
  })

  test("rejects pipelines that reference unknown datasets", () => {
    const step = definePipelineStep("normalize-orders")
      .inputs({ rawOrders: rawOrdersDataset })
      .output(canonicalOrdersDataset)
      .run(async () => {})
    const pipeline = definePipeline("normalize-orders").then(step)

    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [],
          datasets: [rawOrdersDataset],
          pipelines: [pipeline],
          ...createTestRuntimeDeps(),
        })
    ).toThrow(RuntimeError)
    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [],
          datasets: [rawOrdersDataset],
          pipelines: [pipeline],
          ...createTestRuntimeDeps(),
        })
    ).toThrow("outputs unknown dataset 'canonical.orders'")
  })
})
