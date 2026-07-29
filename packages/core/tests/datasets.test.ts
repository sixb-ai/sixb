import { describe, expect, test } from "bun:test"
import {
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

describe("defineDataset", () => {
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

    expect(sixb.listDatasets().map((dataset) => dataset.id)).toEqual([
      "raw.erp.orders",
      "canonical.orders",
    ])
    expect(sixb.getDatasetById("raw.erp.orders")).toBe(rawOrdersDataset)
    expect(sixb.getDatasetById("missing-dataset")).toBeNull()
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
