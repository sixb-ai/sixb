import { describe, expect, test } from "bun:test"
import {
  col,
  defineDataset,
  defineObjectType,
  defineProjection,
  type ObjectProjectionDefinition,
  OntologyRegistry,
  prop,
} from "@sixb/core"
import { buildObjectProjectionPlan, projectObjectRow } from "../src/object-projection-plan"
import { assertProjectionCompatibleWithDataset } from "../src/schema-validation"

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

  test("preserves a canonical source update timestamp for mostRecent resolution", () => {
    const Issue = defineObjectType({
      id: "Issue",
      name: "Issue",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("title", "string"),
      ],
    })
    const issues = defineDataset("github.issues", {
      schema: [col("id", "string"), col("title", "string"), col("updated_at", "timestamp")],
    })
    const projection = defineProjection("github-issues", Issue)
      .fromDataset(issues)
      .properties({ id: "id", title: "title" })
      .resolveConflicts({ strategy: "mostRecent", sourceTimestamp: "updated_at" })
    const ontology = new OntologyRegistry({ sources: [Issue] })
    const plan = buildObjectProjectionPlan({
      ontology,
      projection,
      dataset: issues,
      primaryPropertyId: "id",
    })

    expect(
      projectObjectRow(plan, {
        id: "issue-1",
        title: "First title",
        updated_at: "2026-01-02T03:04:05Z",
      })
    ).toEqual({
      ok: true,
      row: {
        properties: { id: "issue-1", title: "First title" },
        primaryValue: "issue-1",
        foreignKeyValues: {},
        sourceUpdatedAt: "2026-01-02T03:04:05.000Z",
      },
    })
  })

  test("uses strict UTC parsing for source update timestamps", () => {
    const Issue = defineObjectType({
      id: "Issue",
      name: "Issue",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("title", "string"),
      ],
    })
    const issues = defineDataset("github.issues", {
      schema: [col("id", "string"), col("title", "string"), col("updated_at", "timestamp")],
    })
    const projection = defineProjection("github-issues", Issue)
      .fromDataset(issues)
      .properties({ id: "id", title: "title" })
      .resolveConflicts({ strategy: "mostRecent", sourceTimestamp: "updated_at" })
    const plan = buildObjectProjectionPlan({
      ontology: new OntologyRegistry({ sources: [Issue] }),
      projection,
      dataset: issues,
      primaryPropertyId: "id",
    })

    expect(
      projectObjectRow(plan, {
        id: "issue-1",
        title: "Title",
        updated_at: "2026-01-02 03:04:05",
      })
    ).toMatchObject({
      ok: true,
      row: { sourceUpdatedAt: "2026-01-02T03:04:05.000Z" },
    })
    expect(
      projectObjectRow(plan, {
        id: "issue-1",
        title: "Title",
        updated_at: "2026-02-30T03:04:05Z",
      })
    ).toEqual({
      ok: false,
      errorMessage:
        "[SixbProjectionWorker] Projection 'github-issues' source timestamp 'updated_at' is invalid.",
    })
  })

  test("rejects nullable source update timestamps before reading rows", () => {
    const Issue = defineObjectType({
      id: "Issue",
      name: "Issue",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("title", "string"),
      ],
    })
    const issues = defineDataset("github.issues", {
      schema: [
        col("id", "string"),
        col("title", "string"),
        col("updated_at", "timestamp", { nullable: true }),
      ],
    })
    const projection: ObjectProjectionDefinition = {
      ...defineProjection("github-issues", Issue)
        .fromDataset(issues)
        .properties({ id: "id", title: "title" }),
      conflictResolution: { strategy: "mostRecent", sourceTimestamp: "updated_at" },
    }

    expect(() =>
      assertProjectionCompatibleWithDataset({
        projection,
        dataset: issues,
        version: {
          datasetId: issues.id,
          versionId: "v1",
          mode: "snapshot",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          schema: issues.schema,
        },
        ontology: new OntologyRegistry({ sources: [Issue] }),
      })
    ).toThrow("must be a non-null timestamp dataset column")
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
