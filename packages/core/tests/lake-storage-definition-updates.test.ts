import { describe, expect, test } from "bun:test"
import { col, defineDataset, InMemoryLakeStorage } from "../src"
import {
  assertLakeDatasetDefinitionsCompatible,
  mergeStrictDatasetDefinition,
  planDatasetDefinitionUpdate,
} from "../src/lake-storage"

describe("dataset definition update planning", () => {
  test("returns no change for an unchanged or reordered definition", () => {
    const existing = defineDataset("raw.erp.invoices", {
      schema: [col("invoiceId", "string"), col("tenantId", "string"), col("total", "int64")],
      primaryKey: ["tenantId", "invoiceId"],
    })
    const requested = defineDataset("raw.erp.invoices", {
      schema: [col("total", "int64"), col("tenantId", "string"), col("invoiceId", "string")],
      primaryKey: ["tenantId", "invoiceId"],
    })

    for (const next of [existing, requested]) {
      expect(planDatasetDefinitionUpdate(existing, next)).toMatchObject({
        definition: existing,
        schema: { kind: "none" },
        metadata: { descriptionChanged: false, partitionByChanged: false },
        changed: false,
      })
    }
  })

  test("allows adding nullable columns anywhere in the requested definition", () => {
    const existing = defineDataset("raw.erp.invoices", {
      schema: [col("invoiceId", "string"), col("total", "int64")],
      primaryKey: "invoiceId",
    })
    const requested = defineDataset("raw.erp.invoices", {
      schema: [
        col("currency", "string", { nullable: true }),
        col("invoiceId", "string"),
        col("total", "int64"),
        col("memo", "string", { nullable: true }),
      ],
      primaryKey: "invoiceId",
    })

    expect(planDatasetDefinitionUpdate(existing, requested)).toMatchObject({
      definition: defineDataset("raw.erp.invoices", {
        schema: [
          col("invoiceId", "string"),
          col("total", "int64"),
          col("currency", "string", { nullable: true }),
          col("memo", "string", { nullable: true }),
        ],
        primaryKey: "invoiceId",
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

  test("rejects adding, removing, changing, or reordering a primary key", () => {
    // Regression guard: removing assertPrimaryKeyUnchanged from the planner makes these
    // incompatible definitions succeed.
    const schema = [col("tenantId", "string"), col("invoiceId", "string")] as const
    const unkeyed = defineDataset("raw.erp.invoices", { schema })
    const singleKey = defineDataset("raw.erp.invoices", {
      schema,
      primaryKey: "invoiceId",
    })
    const changedSingleKey = defineDataset("raw.erp.invoices", {
      schema,
      primaryKey: "tenantId",
    })
    const compositeKey = defineDataset("raw.erp.invoices", {
      schema,
      primaryKey: ["tenantId", "invoiceId"],
    })
    const reorderedCompositeKey = defineDataset("raw.erp.invoices", {
      schema,
      primaryKey: ["invoiceId", "tenantId"],
    })

    expect(() => planDatasetDefinitionUpdate(unkeyed, singleKey)).toThrow("incompatible primaryKey")
    expect(() => planDatasetDefinitionUpdate(singleKey, unkeyed)).toThrow("incompatible primaryKey")
    expect(() => planDatasetDefinitionUpdate(singleKey, changedSingleKey)).toThrow(
      "incompatible primaryKey"
    )
    expect(() => planDatasetDefinitionUpdate(compositeKey, reorderedCompositeKey)).toThrow(
      "incompatible primaryKey"
    )
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

  test("strict merge and the lake compatibility preflight reject schema evolution", async () => {
    const storage = new InMemoryLakeStorage()
    const existing = defineDataset("raw.erp.invoices", {
      schema: [col("invoiceId", "string")],
    })
    const requested = defineDataset("raw.erp.invoices", {
      schema: [col("invoiceId", "string"), col("currency", "string", { nullable: true })],
    })

    expect(() => mergeStrictDatasetDefinition({ existing, next: requested })).toThrow(
      "incompatible schema"
    )

    await storage.createDataset(existing)
    await expect(
      assertLakeDatasetDefinitionsCompatible({
        lakeStorage: storage,
        definitions: [requested],
      })
    ).rejects.toThrow(/Lake dataset definition check failed[\s\S]*incompatible schema/)
  })
})
