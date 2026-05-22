import { describe, expect, test } from "bun:test"
import {
  assertLakeDatasetDefinitionsCompatible,
  col,
  defineDataset,
  InMemoryLakeStorage,
  mergeStrictDatasetDefinition,
  planDatasetDefinitionUpdate,
} from "../src"

describe("dataset definition update planning", () => {
  test("returns no change for an unchanged definition", () => {
    const dataset = defineDataset("raw.erp.invoices", {
      schema: [col("invoiceId", "string"), col("total", "int64")],
    })

    expect(planDatasetDefinitionUpdate(dataset, dataset)).toMatchObject({
      definition: dataset,
      schema: { kind: "none" },
      metadata: { descriptionChanged: false, partitionByChanged: false },
      changed: false,
    })
  })

  test("ignores declaration reordering for existing columns", () => {
    const existing = defineDataset("raw.erp.invoices", {
      schema: [col("invoiceId", "string"), col("total", "int64")],
    })
    const requested = defineDataset("raw.erp.invoices", {
      schema: [col("total", "int64"), col("invoiceId", "string")],
    })

    expect(planDatasetDefinitionUpdate(existing, requested)).toMatchObject({
      definition: existing,
      schema: { kind: "none" },
      changed: false,
    })
  })

  test("allows adding nullable columns anywhere in the requested definition", () => {
    const existing = defineDataset("raw.erp.invoices", {
      schema: [col("invoiceId", "string"), col("total", "int64")],
    })
    const requested = defineDataset("raw.erp.invoices", {
      schema: [
        col("currency", "string", { nullable: true }),
        col("invoiceId", "string"),
        col("total", "int64"),
        col("memo", "string", { nullable: true }),
      ],
    })

    expect(planDatasetDefinitionUpdate(existing, requested)).toMatchObject({
      definition: defineDataset("raw.erp.invoices", {
        schema: [
          col("invoiceId", "string"),
          col("total", "int64"),
          col("currency", "string", { nullable: true }),
          col("memo", "string", { nullable: true }),
        ],
      }),
      schema: {
        kind: "addNullableColumns",
        columns: [
          col("currency", "string", { nullable: true }),
          col("memo", "string", { nullable: true }),
        ],
      },
      changed: true,
    })
  })

  test("detects compatible metadata additions", () => {
    const existing = defineDataset("raw.erp.orders", {
      schema: [col("orderId", "string"), col("orderDate", "date")],
    })
    const requested = defineDataset("raw.erp.orders", {
      schema: [col("orderDate", "date"), col("orderId", "string")],
      partitionBy: ["orderDate"],
      description: "Raw ERP orders",
    })

    expect(planDatasetDefinitionUpdate(existing, requested)).toMatchObject({
      definition: defineDataset("raw.erp.orders", {
        schema: [col("orderId", "string"), col("orderDate", "date")],
        partitionBy: ["orderDate"],
        description: "Raw ERP orders",
      }),
      schema: { kind: "none" },
      metadata: { descriptionChanged: true, partitionByChanged: true },
      changed: true,
    })
  })

  test("rejects unsupported schema updates", () => {
    const existing = defineDataset("raw.erp.invoices", {
      schema: [col("invoiceId", "string"), col("total", "int64")],
    })

    expect(() =>
      planDatasetDefinitionUpdate(
        existing,
        defineDataset("raw.erp.invoices", {
          schema: [col("invoiceId", "string"), col("total", "int64"), col("currency", "string")],
        })
      )
    ).toThrow("adding required column 'currency' is not supported")

    expect(() =>
      planDatasetDefinitionUpdate(
        existing,
        defineDataset("raw.erp.invoices", {
          schema: [col("invoiceId", "string")],
        })
      )
    ).toThrow("dropping column 'total' is not supported")

    expect(() =>
      planDatasetDefinitionUpdate(
        existing,
        defineDataset("raw.erp.invoices", {
          schema: [col("invoiceId", "string"), col("total", "decimal")],
        })
      )
    ).toThrow("changing column 'total' type from 'int64' to 'decimal' is not supported")

    expect(() =>
      planDatasetDefinitionUpdate(
        existing,
        defineDataset("raw.erp.invoices", {
          schema: [col("invoiceId", "string"), col("total", "int64", { nullable: true })],
        })
      )
    ).toThrow("changing column 'total' nullability is not supported")
  })

  test("rejects incompatible metadata updates", () => {
    const existing = defineDataset("raw.erp.orders", {
      schema: [col("orderId", "string"), col("orderDate", "date")],
      partitionBy: ["orderId"],
      description: "Raw ERP orders",
    })

    expect(() =>
      planDatasetDefinitionUpdate(
        existing,
        defineDataset("raw.erp.orders", {
          schema: [col("orderId", "string"), col("orderDate", "date")],
          partitionBy: ["orderDate"],
          description: "Raw ERP orders",
        })
      )
    ).toThrow("incompatible partitionBy")

    expect(() =>
      planDatasetDefinitionUpdate(
        existing,
        defineDataset("raw.erp.orders", {
          schema: [col("orderId", "string"), col("orderDate", "date")],
          partitionBy: ["orderId"],
          description: "Changed",
        })
      )
    ).toThrow("incompatible description")
  })

  test("strict merge rejects schema evolution plans", () => {
    const existing = defineDataset("raw.erp.invoices", {
      schema: [col("invoiceId", "string")],
    })
    const requested = defineDataset("raw.erp.invoices", {
      schema: [col("invoiceId", "string"), col("currency", "string", { nullable: true })],
    })

    expect(() => mergeStrictDatasetDefinition({ existing, next: requested })).toThrow(
      "incompatible schema"
    )
  })

  test("lake compatibility preflight is read-only for missing datasets", async () => {
    const storage = new InMemoryLakeStorage()
    const dataset = defineDataset("raw.erp.invoices", {
      schema: [col("invoiceId", "string")],
    })

    await assertLakeDatasetDefinitionsCompatible({
      lakeStorage: storage,
      definitions: [dataset],
    })

    expect(await storage.getDataset(dataset.id)).toBeNull()
  })

  test("lake compatibility preflight rejects provider-unsupported updates", async () => {
    const storage = new InMemoryLakeStorage()
    const existing = defineDataset("raw.erp.invoices", {
      schema: [col("invoiceId", "string")],
    })
    const requested = defineDataset("raw.erp.invoices", {
      schema: [col("invoiceId", "string"), col("currency", "string", { nullable: true })],
    })

    await storage.createDataset(existing)

    await expect(
      assertLakeDatasetDefinitionsCompatible({
        lakeStorage: storage,
        definitions: [requested],
      })
    ).rejects.toThrow(/Lake dataset definition check failed[\s\S]*incompatible schema/)
  })
})
