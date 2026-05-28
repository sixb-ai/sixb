import { describe, expect, test } from "bun:test"
import {
  parseCommitMetadata,
  parseInlineDataChange,
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

  test("parses Pario commit metadata from DuckLake extra info", () => {
    expect(
      parseCommitMetadata(
        JSON.stringify({
          pario: {
            kind: "datasetVersion",
            datasetId: "raw.erp.orders",
            commitId: "commit_123",
            mode: "schema",
            producer: { kind: "sync", id: "sync-orders", runId: "run_123" },
            inputs: [{ datasetId: "raw.erp.customers", versionId: "ducklake:7" }],
            rowCount: 1250,
            schemaChange: { addColumns: ["currency"] },
          },
        })
      )
    ).toEqual({
      kind: "datasetVersion",
      datasetId: "raw.erp.orders",
      commitId: "commit_123",
      mode: "schema",
      producer: { kind: "sync", id: "sync-orders", runId: "run_123" },
      inputs: [{ datasetId: "raw.erp.customers", versionId: "ducklake:7" }],
      rowCount: 1250,
      schemaChange: { addColumns: ["currency"] },
    })
  })

  test("ignores malformed optional commit metadata fields", () => {
    expect(parseCommitMetadata(undefined)).toBeUndefined()
    expect(parseCommitMetadata("{not-json")).toBeUndefined()
    expect(parseCommitMetadata(JSON.stringify({ pario: {} }))).toBeUndefined()
    expect(
      parseCommitMetadata(JSON.stringify({ pario: { datasetId: "raw.erp.orders" } }))
    ).toBeUndefined()

    expect(
      parseCommitMetadata(
        JSON.stringify({
          pario: {
            kind: "datasetVersion",
            datasetId: "raw.erp.orders",
            mode: "merge",
            producer: { kind: "job" },
            inputs: [{ datasetId: "raw.erp.customers" }],
            schemaChange: { addColumns: ["currency", 42] },
            rowCount: "1250",
          },
        })
      )
    ).toEqual({ kind: "datasetVersion", datasetId: "raw.erp.orders" })
  })

  test("detects table-specific inline data changes", () => {
    expect(parseInlineDataChange("insert:41,delete:42", 42n)).toEqual({
      hasDataChange: true,
      hasDeleteChange: true,
    })
    expect(parseInlineDataChange("metadata:42,insert:43", 42n)).toEqual({
      hasDataChange: false,
      hasDeleteChange: false,
    })
  })
})
