import { describe, expect, test } from "bun:test"
import type { MaterializationPlanHeader } from "../src/storage/ontology"
import { assertMaterializationHeader } from "../src/storage/ontology/provider-header-validation"

const datasetVersion = {
  datasetId: "devices",
  versionId: "v1",
  createdAt: "2026-01-01T00:00:00.000Z",
} as const

const expected = {
  sources: [],
  objects: [],
  links: [],
  linkScopes: [],
  points: [],
} as const

function projectionHeader(originProjectionId = "devices"): MaterializationPlanHeader {
  return {
    commit: {
      projectId: "project",
      id: "projection-commit",
      idempotencyKey: "projection:run",
      requestHash: "projection-request",
      executionId: "projection-execution",
      origin: {
        kind: "projection",
        projectionId: originProjectionId,
        projectionRunId: "run",
        datasetId: datasetVersion.datasetId,
        datasetVersionId: datasetVersion.versionId,
      },
      ontologyRevision: "ontology-revision",
      projectionRevision: "projection-revision",
      ownershipHash: "ownership-hash",
      committedAt: "2026-01-02T00:00:00.000Z",
      intent: {
        kind: "projection",
        source: { projectionId: "devices" },
        datasetVersion,
      },
    },
    expected,
  }
}

function telemetryHeader(input?: {
  readonly sourceRowCount?: number
  readonly sourceRowsSkipped?: number
  readonly inputPointCount?: number
}): MaterializationPlanHeader {
  const sourceRowCount = input?.sourceRowCount ?? 2
  const sourceRowsSkipped = input?.sourceRowsSkipped ?? 1
  const inputPointCount = input?.inputPointCount ?? 1

  return {
    commit: {
      projectId: "project",
      id: "telemetry-commit",
      idempotencyKey: "projection:run:batch:0",
      requestHash: "telemetry-request",
      executionId: "projection-execution",
      origin: {
        kind: "telemetry",
        source: {
          kind: "projection",
          projectionId: "device-readings",
          projectionRunId: "run",
          datasetId: datasetVersion.datasetId,
          datasetVersionId: datasetVersion.versionId,
          batchOrdinal: 0,
        },
      },
      ontologyRevision: "ontology-revision",
      projectionRevision: "projection-revision",
      ownershipHash: "ownership-hash",
      committedAt: "2026-01-02T00:00:00.000Z",
      intent: {
        kind: "telemetry",
        pointCount: inputPointCount,
        inputPointCount,
        source: {
          kind: "projection",
          projection: { projectionId: "device-readings" },
          datasetVersion,
          batchOrdinal: 0,
          sourceRowCount,
          sourceRowsSkipped,
          inputExhausted: true,
        },
      },
    },
    expected,
  }
}

describe("materialization header validation", () => {
  test("accepts correlated projection and telemetry headers", () => {
    expect(() => assertMaterializationHeader(projectionHeader())).not.toThrow()
    expect(() => assertMaterializationHeader(telemetryHeader())).not.toThrow()
    expect(() =>
      assertMaterializationHeader(
        telemetryHeader({ sourceRowCount: 2, sourceRowsSkipped: 0, inputPointCount: 4 })
      )
    ).not.toThrow()
  })

  test("reports the exact projection correlation that failed", () => {
    expect(() => assertMaterializationHeader(projectionHeader("other"))).toThrow(
      "Projection commit origin does not match its projection."
    )
  })

  test("reports invalid telemetry row accounting independently", () => {
    expect(() =>
      assertMaterializationHeader(
        telemetryHeader({ sourceRowCount: 3, sourceRowsSkipped: 1, inputPointCount: 1 })
      )
    ).toThrow("Projection telemetry input points do not account for every non-skipped source row.")
  })
})
