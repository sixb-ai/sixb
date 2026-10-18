import { describe, expect, test } from "bun:test"
import type { ProjectionMaterializationIdentity } from "../src/materialization/model"
import { chunkBySize } from "../src/materializer/shared/chunking"
import {
  createCommitId,
  createCommitIdentity,
  createProjectionIdempotencyKey,
  createProjectionTelemetryIdempotencyKey,
  createTimedCommitIdentity,
  sha256Canonical,
  timestampCommitIdentity,
} from "../src/materializer/shared/identity"

const projectionIdentity = {
  projectionId: "projection:a",
  projectionKind: "object",
  protocol: "replacement",
  datasetVersion: {
    datasetId: "dataset:b",
    versionId: "version:c",
    createdAt: "2026-01-02T03:04:05.000Z",
  },
  ontologyRevision: "ontology:d",
  projectionRevision: "projection:e",
  ownershipHash: "ownership:f",
} satisfies ProjectionMaterializationIdentity

describe("materializer identity", () => {
  test("adds commit time only when explicitly requested", () => {
    const identity = createCommitIdentity({
      projectId: "project",
      idempotencyKey: "runtime:request",
      normalizedCallerIntent: { operation: "empty" },
    })

    expect(identity).toEqual({
      idempotencyKey: "runtime:request",
      requestHash: sha256Canonical({ operation: "empty" }),
      commitId: createCommitId("project", "runtime:request"),
    })
    expect("committedAt" in identity).toBe(false)
    expect(timestampCommitIdentity(identity, new Date("2026-01-02T03:04:05.000Z"))).toEqual({
      ...identity,
      committedAt: "2026-01-02T03:04:05.000Z",
    })
    expect(
      createTimedCommitIdentity({
        projectId: "project",
        idempotencyKey: "runtime:request",
        normalizedCallerIntent: { operation: "empty" },
        now: new Date("2026-01-02T03:04:05.000Z"),
      })
    ).toEqual({
      ...identity,
      committedAt: "2026-01-02T03:04:05.000Z",
    })
    expect(() => timestampCommitIdentity(identity, new Date("invalid"))).toThrow(
      "Materialization commit time must be a valid date."
    )
  })

  test("hashes the complete projection replacement identity without delimiter collisions", () => {
    const key = createProjectionIdempotencyKey(projectionIdentity)

    expect(key).toMatch(/^projection:replace:[0-9a-f]{64}$/)
    expect(key).toBe(createProjectionIdempotencyKey(projectionIdentity))
    expect(key).not.toBe(
      createProjectionIdempotencyKey({
        ...projectionIdentity,
        projectionId: "projection",
        datasetVersion: {
          ...projectionIdentity.datasetVersion,
          datasetId: "a:dataset:b",
        },
      })
    )
    expect(key).not.toBe(
      createProjectionIdempotencyKey({
        ...projectionIdentity,
        ontologyRevision: "ontology:other",
      })
    )
    expect(key).not.toBe(
      createProjectionIdempotencyKey({
        ...projectionIdentity,
        projectionKind: "link",
      })
    )
    expect(key).not.toBe(
      createProjectionIdempotencyKey({
        ...projectionIdentity,
        datasetVersion: {
          ...projectionIdentity.datasetVersion,
          createdAt: "2026-01-02T03:04:06.000Z",
        },
      })
    )
    expect(key).not.toBe(
      createProjectionIdempotencyKey({
        ...projectionIdentity,
        ownershipHash: "ownership:other",
      })
    )
  })

  test("hashes projection telemetry by full identity and batch ordinal only", () => {
    const withTransportFields = {
      ...projectionIdentity,
      projectionKind: "telemetry" as const,
      protocol: "telemetry" as const,
      batchOrdinal: 7,
      executionToken: "token-one",
      deliveryAttempt: 1,
    }
    const key = createProjectionTelemetryIdempotencyKey(
      withTransportFields,
      withTransportFields.batchOrdinal
    )
    const withOtherTransportFields = {
      ...withTransportFields,
      executionToken: "token-two",
      deliveryAttempt: 2,
    }

    expect(key).toMatch(/^telemetry:projection:[0-9a-f]{64}$/)
    expect(key).toBe(
      createProjectionTelemetryIdempotencyKey(
        withOtherTransportFields,
        withOtherTransportFields.batchOrdinal
      )
    )
    expect(key).not.toBe(createProjectionTelemetryIdempotencyKey(withTransportFields, 8))
    expect(key).not.toBe(
      createProjectionTelemetryIdempotencyKey(
        { ...withTransportFields, projectionRevision: "projection:other" },
        withTransportFields.batchOrdinal
      )
    )
  })
})

describe("chunkBySize", () => {
  // Each step is the chunk a pull yields and how many source rows had been pulled by then: a
  // chunk is yielded as soon as it is full, before the next row is read.
  test.each([
    {
      name: "yields the Nth row before pulling row N+1",
      items: [1, 2, 3],
      maxRows: 2,
      maxBytes: 100,
      byteLength: () => 1,
      steps: [
        [[1, 2], 2],
        [[3], 3],
      ],
    },
    {
      name: "yields at the byte limit before pulling another row",
      items: [2, 2, 1],
      maxRows: 100,
      maxBytes: 4,
      byteLength: (item: number) => item,
      steps: [
        [[2, 2], 2],
        [[1], 3],
      ],
    },
    {
      name: "emits an oversized row alone without pulling the following row",
      items: [2, 5, 1],
      maxRows: 100,
      maxBytes: 4,
      byteLength: (item: number) => item,
      steps: [
        [[2], 2],
        [[5], 2],
        [[1], 3],
      ],
    },
  ])("$name", async ({ items, maxRows, maxBytes, byteLength, steps }) => {
    let pulls = 0
    async function* source(): AsyncIterable<number> {
      for (const item of items) {
        pulls += 1
        yield item
      }
    }

    const chunks = chunkBySize(source(), { maxRows, maxBytes, byteLength })[Symbol.asyncIterator]()

    for (const [chunk, pulled] of steps) {
      await expect(chunks.next()).resolves.toEqual({ done: false, value: chunk })
      expect(pulls).toBe(pulled)
    }
  })
})
