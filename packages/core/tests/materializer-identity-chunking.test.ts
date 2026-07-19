import { describe, expect, test } from "bun:test"
import { chunkBySize } from "../src/materializer/shared/chunking"
import {
  createCommitId,
  createCommitIdentity,
  createProjectionIdempotencyKey,
  createProjectionMaterializationId,
  createProjectionTelemetryIdempotencyKey,
  createTimedCommitIdentity,
  type ProjectionMaterializationFingerprint,
  sha256Canonical,
  timestampCommitIdentity,
} from "../src/materializer/shared/identity"

const projectionFingerprint = {
  source: { projectionId: "projection:a" },
  projectionKind: "object",
  datasetVersion: {
    datasetId: "dataset:b",
    versionId: "version:c",
    createdAt: "2026-01-02T03:04:05.000Z",
  },
  ontologyRevision: "ontology:d",
  projectionRevision: "projection:e",
  ownershipHash: "ownership:f",
} satisfies ProjectionMaterializationFingerprint

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

  test("hashes the complete projection replacement fingerprint without delimiter collisions", () => {
    const key = createProjectionIdempotencyKey(projectionFingerprint)

    expect(key).toMatch(/^projection:replace:[0-9a-f]{64}$/)
    expect(key).toBe(createProjectionIdempotencyKey(projectionFingerprint))
    expect(key).not.toBe(
      createProjectionIdempotencyKey({
        ...projectionFingerprint,
        source: { projectionId: "projection" },
        datasetVersion: {
          ...projectionFingerprint.datasetVersion,
          datasetId: "a:dataset:b",
        },
      })
    )
    expect(key).not.toBe(
      createProjectionIdempotencyKey({
        ...projectionFingerprint,
        ontologyRevision: "ontology:other",
      })
    )
    expect(key).not.toBe(
      createProjectionIdempotencyKey({
        ...projectionFingerprint,
        projectionKind: "link",
      })
    )
    expect(key).not.toBe(
      createProjectionIdempotencyKey({
        ...projectionFingerprint,
        datasetVersion: {
          ...projectionFingerprint.datasetVersion,
          createdAt: "2026-01-02T03:04:06.000Z",
        },
      })
    )
    expect(key).not.toBe(
      createProjectionIdempotencyKey({
        ...projectionFingerprint,
        ownershipHash: "ownership:other",
      })
    )
  })

  test("hashes projection telemetry by full fingerprint and batch ordinal only", () => {
    const withTransportFields = {
      ...projectionFingerprint,
      projectionKind: "telemetry" as const,
      batchOrdinal: 7,
      executionToken: "token-one",
      deliveryAttempt: 1,
    }
    const key = createProjectionTelemetryIdempotencyKey(withTransportFields)
    const withOtherTransportFields = {
      ...withTransportFields,
      executionToken: "token-two",
      deliveryAttempt: 2,
    }

    expect(key).toMatch(/^telemetry:projection:[0-9a-f]{64}$/)
    expect(key).toBe(createProjectionTelemetryIdempotencyKey(withOtherTransportFields))
    expect(key).not.toBe(
      createProjectionTelemetryIdempotencyKey({ ...withTransportFields, batchOrdinal: 8 })
    )
    expect(key).not.toBe(
      createProjectionTelemetryIdempotencyKey({
        ...withTransportFields,
        projectionRevision: "projection:other",
      })
    )
  })

  test("creates fresh projection materialization ids", () => {
    const first = createProjectionMaterializationId()
    const second = createProjectionMaterializationId()

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(second).not.toBe(first)
  })
})

describe("chunkBySize", () => {
  test("yields the Nth row before pulling row N+1", async () => {
    let pulls = 0
    async function* source(): AsyncIterable<number> {
      for (const item of [1, 2, 3]) {
        pulls += 1
        yield item
      }
    }

    const chunks = chunkBySize(source(), {
      maxRows: 2,
      maxBytes: 100,
      byteLength: () => 1,
    })[Symbol.asyncIterator]()

    await expect(chunks.next()).resolves.toEqual({ done: false, value: [1, 2] })
    expect(pulls).toBe(2)
    await expect(chunks.next()).resolves.toEqual({ done: false, value: [3] })
    expect(pulls).toBe(3)
  })

  test("yields at the byte limit before pulling another row", async () => {
    let pulls = 0
    async function* source(): AsyncIterable<number> {
      for (const item of [2, 2, 1]) {
        pulls += 1
        yield item
      }
    }

    const chunks = chunkBySize(source(), {
      maxRows: 100,
      maxBytes: 4,
      byteLength: (item) => item,
    })[Symbol.asyncIterator]()

    await expect(chunks.next()).resolves.toEqual({ done: false, value: [2, 2] })
    expect(pulls).toBe(2)
    await expect(chunks.next()).resolves.toEqual({ done: false, value: [1] })
    expect(pulls).toBe(3)
  })

  test("emits an oversized row alone without pulling the following row", async () => {
    let pulls = 0
    async function* source(): AsyncIterable<number> {
      for (const item of [2, 5, 1]) {
        pulls += 1
        yield item
      }
    }

    const chunks = chunkBySize(source(), {
      maxRows: 100,
      maxBytes: 4,
      byteLength: (item) => item,
    })[Symbol.asyncIterator]()

    await expect(chunks.next()).resolves.toEqual({ done: false, value: [2] })
    expect(pulls).toBe(2)
    await expect(chunks.next()).resolves.toEqual({ done: false, value: [5] })
    expect(pulls).toBe(2)
    await expect(chunks.next()).resolves.toEqual({ done: false, value: [1] })
    expect(pulls).toBe(3)
  })
})
