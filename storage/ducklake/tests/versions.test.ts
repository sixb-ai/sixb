import { describe, expect, test } from "bun:test"
import {
  parseCommitMetadata,
  parseTableDataChange,
  parseVersionId,
  toVersionId,
} from "../src/internal/versions"

describe("DuckLake version metadata", () => {
  test("parses and formats DuckLake version ids", () => {
    expect(parseVersionId("ducklake:42")).toBe("42")
    expect(toVersionId("42")).toBe("ducklake:42")

    expect(() => parseVersionId("42")).toThrow("Invalid DuckLake version id")
    expect(() => parseVersionId("ducklake:not-a-number")).toThrow("Invalid DuckLake version id")
  })

  test("parses Sixb commit metadata from DuckLake extra info", () => {
    expect(
      parseCommitMetadata(
        JSON.stringify({
          sixb: {
            kind: "datasetVersion",
            datasetId: "raw.erp.orders",
            commitId: "commit_123",
            mode: "merge",
            producer: { kind: "sync", id: "sync-orders", runId: "run_123" },
            inputs: [{ datasetId: "raw.erp.customers", versionId: "ducklake:7" }],
            rowCount: 1250,
            validatedPrimaryKeyColumns: ["region", "order_id"],
            schemaChange: { addColumns: ["currency"] },
          },
        })
      )
    ).toEqual({
      kind: "datasetVersion",
      datasetId: "raw.erp.orders",
      commitId: "commit_123",
      mode: "merge",
      producer: { kind: "sync", id: "sync-orders", runId: "run_123" },
      inputs: [{ datasetId: "raw.erp.customers", versionId: "ducklake:7" }],
      rowCount: 1250,
      validatedPrimaryKeyColumns: ["region", "order_id"],
      schemaChange: { addColumns: ["currency"] },
    })
  })

  test("ignores malformed optional commit metadata fields", () => {
    expect(parseCommitMetadata(undefined)).toBeUndefined()
    expect(parseCommitMetadata("{not-json")).toBeUndefined()
    expect(parseCommitMetadata(JSON.stringify({ sixb: {} }))).toBeUndefined()
    expect(
      parseCommitMetadata(JSON.stringify({ sixb: { datasetId: "raw.erp.orders" } }))
    ).toBeUndefined()

    expect(
      parseCommitMetadata(
        JSON.stringify({
          sixb: {
            kind: "datasetVersion",
            datasetId: "raw.erp.orders",
            mode: "replace",
            producer: { kind: "job" },
            inputs: [{ datasetId: "raw.erp.customers" }],
            schemaChange: { addColumns: ["currency", 42] },
            rowCount: "1250",
            validatedPrimaryKeyColumns: ["order_id", "order_id"],
          },
        })
      )
    ).toEqual({ kind: "datasetVersion", datasetId: "raw.erp.orders" })

    expect(
      parseCommitMetadata(
        JSON.stringify({
          sixb: {
            kind: "datasetVersion",
            datasetId: "raw.erp.orders",
            validatedPrimaryKeyColumns: ["order_id"],
          },
        })
      )
    ).toEqual({ kind: "datasetVersion", datasetId: "raw.erp.orders" })
  })

  describe("lineage and producers", () => {
    const pipeline = {
      kind: "pipeline",
      id: "insights",
      runId: "run_1",
      stepId: "aggregate",
    } as const
    const metadataOf = (fields: Record<string, unknown>) =>
      parseCommitMetadata(
        JSON.stringify({ sixb: { kind: "datasetVersion", datasetId: "analytics", ...fields } })
      )

    test("carries the stored lineage untouched, for the reads that return it to decode", () => {
      expect(metadataOf({ producer: pipeline, lineage: "encoded" })).toMatchObject({
        producer: pipeline,
        lineage: "encoded",
      })
      expect(metadataOf({ lineage: 42 })?.lineage).toBe(42)
      expect(metadataOf({ producer: pipeline })).not.toHaveProperty("lineage")
    })

    // Regression proof: drop the whole producer when one field is malformed. The version then
    // stops reading as a pipeline version, which is classified with every marking without lineage.
    test("keeps the kind of a producer with malformed fields", () => {
      expect(metadataOf({ producer: { ...pipeline, runId: 7, stepId: ["aggregate"] } })).toEqual({
        kind: "datasetVersion",
        datasetId: "analytics",
        producer: { kind: "pipeline", id: "insights" },
      })
      expect(metadataOf({ producer: { kind: "pipeline", id: null } })?.producer).toEqual({
        kind: "pipeline",
      })
      expect(metadataOf({ producer: { kind: "job", id: "insights" } })?.producer).toBeUndefined()
    })
  })

  test("detects table-specific data changes", () => {
    expect(parseTableDataChange("insert:41,delete:42", 42n)).toEqual({
      hasDataChange: true,
      hasDeleteChange: true,
    })
    expect(parseTableDataChange("inserted_into_table:42,altered_table:43", 42n)).toEqual({
      hasDataChange: true,
      hasDeleteChange: false,
    })
    expect(parseTableDataChange("metadata:42,insert:43", 42n)).toEqual({
      hasDataChange: false,
      hasDeleteChange: false,
    })
  })
})
