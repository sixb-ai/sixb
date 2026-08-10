import { describe, expect, test } from "bun:test"
import {
  col,
  defineDataset,
  defineObjectType,
  defineProjection,
  OntologyRegistry,
  prop,
} from "@sixb/core"
import { buildObjectProjectionPlan, projectObjectRow } from "../src/object-projection-plan"

describe("object projection plan", () => {
  test("preserves decimal precision from dataset row to object properties", () => {
    const Invoice = defineObjectType({
      id: "Invoice",
      name: "Invoice",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("amount", "decimal", { required: true }),
      ],
    })
    const invoices = defineDataset("canonical.invoices", {
      schema: [col("id", "string"), col("amount", "decimal")],
    })
    const projection = defineProjection("invoice-projection", Invoice)
      .fromDataset(invoices)
      .properties({ id: "id", amount: "amount" })
    const ontology = new OntologyRegistry({ sources: [Invoice] })
    const plan = buildObjectProjectionPlan({
      ontology,
      projection,
      dataset: invoices,
      primaryPropertyId: "id",
    })

    expect(projectObjectRow(plan, { id: "invoice-1", amount: "+009007199254740993.0100" })).toEqual(
      {
        ok: true,
        row: {
          properties: { id: "invoice-1", amount: "9007199254740993.01" },
          primaryValue: "invoice-1",
          foreignKeyValues: {},
        },
      }
    )
  })

  test("validates original dataset row before numeric projection coercion", () => {
    const Meter = defineObjectType({
      id: "Meter",
      name: "Meter",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("reading", "double"),
      ],
    })
    const readingsDataset = defineDataset("canonical.meter-readings", {
      schema: [col("meter_id", "string"), col("reading", "float64")],
    })
    const readingProjection = defineProjection("meter-reading-proj", Meter)
      .fromDataset(readingsDataset)
      .properties({ id: "meter_id", reading: "reading" })
    const ontology = new OntologyRegistry({ sources: [Meter] })
    const plan = buildObjectProjectionPlan({
      ontology,
      projection: readingProjection,
      dataset: readingsDataset,
      primaryPropertyId: ontology.getPrimaryPropertyId("Meter"),
    })

    expect(projectObjectRow(plan, { meter_id: "m1", reading: "1.5" })).toEqual({
      ok: false,
      errorMessage:
        "Dataset 'canonical.meter-readings' column 'reading' must match type 'float64'.",
    })
  })

  test("codes an execution plan invariant with its projection correlation", () => {
    const Account = defineObjectType({
      id: "Account",
      name: "Account",
      properties: [prop("id", "string", { required: true, primary: true })],
    })
    const accounts = defineDataset("canonical.accounts", {
      schema: [col("account_id", "string")],
    })
    const projection = defineProjection("account-projection", Account)
      .fromDataset(accounts)
      .properties({ id: "account_id" })

    let caught: unknown
    try {
      buildObjectProjectionPlan({
        ontology: new OntologyRegistry({ sources: [] }),
        projection,
        dataset: accounts,
        primaryPropertyId: "id",
        correlation: { runId: "projection-run-1", versionId: "version-1" },
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({
      code: "internal.unexpected",
      retryable: false,
      message: expect.stringContaining("references unknown object type 'Account'"),
      details: {
        projectionId: projection.id,
        runId: "projection-run-1",
        datasetId: accounts.id,
        versionId: "version-1",
        objectTypeId: Account.id,
      },
    })
  })
})
