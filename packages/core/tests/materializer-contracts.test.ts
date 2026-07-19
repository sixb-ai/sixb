import { describe, expect, test } from "bun:test"
import type {
  AdvanceProjectionTelemetryCheckpointInput,
  ApplyMaterializationChunkInput,
  ApplyMaterializationResult,
  FinalizeMaterializationInput,
  MaterializationPlanHeader,
  MaterializationSession,
  MaterializationStatePage,
  MaterializationWorkPage,
  OntologyCommitRecord,
  OntologyCommitWrite,
  OntologyMaterializationEvent,
  OntologyMaterializationStorage,
  OntologyOutboxWrite,
  OntologySourceStorage,
  ReadMaterializationObjectExistenceInput,
  SourceReplacementStatePage,
  StageMaterializationWorkInput,
  StageSourceAssertion,
  StreamMaterializationStateInput,
  StreamMaterializationWorkInput,
  StreamSourceReplacementStateInput,
} from "@sixb/core/storage"
import * as rootExports from "../src"
import {
  createCommitId,
  createEventId,
  createOntologyMaterializer,
  createTimedCommitIdentity,
  linkRefKey,
  normalizeOntologyEditCommit,
  normalizeProjectionSourceEntry,
  normalizeTelemetryAppend,
  ONTOLOGY_MATERIALIZATION_EVENT_KIND_ORDER,
  objectRefKey,
  projectionEntityKey,
  sha256Canonical,
} from "../src/materializer"
import { planStream } from "../src/materializer/execution/plan-stream"
import {
  DEFAULT_MATERIALIZATION_BATCHING,
  resolveMaterializationBatching,
} from "../src/materializer/shared/batching"
import { createMaterializerFixture } from "./materializer-fixture"

const leftObject = { objectTypeId: "a:b", primaryId: "c" }
const rightObject = { objectTypeId: "a", primaryId: "b:c" }

class FakeMaterializationStorage implements OntologyMaterializationStorage {
  private readonly sessions = new WeakMap<object, MaterializationPlanHeader>()

  async begin(input: MaterializationPlanHeader): Promise<MaterializationSession> {
    const providerToken = {}
    this.sessions.set(providerToken, input)
    return { providerToken }
  }

  async *streamState(
    input: StreamMaterializationStateInput
  ): AsyncIterable<MaterializationStatePage> {
    this.requireActive(input.session)
    yield* []
  }

  async *streamSourceReplacementState(
    input: StreamSourceReplacementStateInput
  ): AsyncIterable<SourceReplacementStatePage> {
    this.requireActive(input.session)
    yield* []
  }

  async stageWork(input: StageMaterializationWorkInput): Promise<void> {
    this.requireActive(input.session)
  }

  async *streamWork(input: StreamMaterializationWorkInput): AsyncIterable<MaterializationWorkPage> {
    this.requireActive(input.session)
    yield* []
  }

  async readObjectExistence(input: ReadMaterializationObjectExistenceInput) {
    this.requireActive(input.session)
    return []
  }

  async applyChunk(input: ApplyMaterializationChunkInput): Promise<void> {
    this.requireActive(input.session)
  }

  async finalize(input: FinalizeMaterializationInput): Promise<ApplyMaterializationResult> {
    this.requireActive(input.session)
    throw new Error("Fake provider does not finalize")
  }

  private requireActive(session: MaterializationSession): MaterializationPlanHeader {
    const header = this.sessions.get(session.providerToken)
    if (!header) throw new Error("Inactive materialization session")
    return header
  }
}

describe("materializer canonical contracts", () => {
  test("rejects storage without ontology capabilities at construction", () => {
    const { ontology, projections, storage } = createMaterializerFixture()
    const malformedStorage = { ...storage, ontology: undefined }

    expect(() =>
      createOntologyMaterializer({
        projectId: "project",
        ontology,
        projections,
        storage: malformedStorage as never,
      })
    ).toThrow("Storage does not provide ontology capabilities")
  })

  test("rejects an Ontology that differs from the projection registry", () => {
    const { projections, storage } = createMaterializerFixture()
    const incompatibleOntology = new rootExports.OntologyRegistry({
      sources: [
        rootExports.defineObjectType({
          id: "Device",
          name: "Device",
          properties: [
            rootExports.prop("id", "string", { primary: true, required: true }),
            rootExports.prop("name", "double", { required: true }),
          ],
        }),
      ],
    })

    expect(() =>
      createOntologyMaterializer({
        projectId: "project",
        ontology: incompatibleOntology,
        projections,
        storage,
      })
    ).toThrow("does not match the Ontology pinned by its projection registry")
  })

  test("uses unambiguous JSON-array keys for every entity kind", () => {
    expect(objectRefKey(leftObject)).toBe('["a:b","c"]')
    expect(objectRefKey(leftObject)).not.toBe(objectRefKey(rightObject))

    const link = {
      source: leftObject,
      linkId: "owns:part",
      target: rightObject,
    }
    expect(linkRefKey(link)).toBe('["a:b","c","owns:part","a","b:c"]')
    expect(projectionEntityKey({ kind: "link", ref: link })).toBe(
      '["link","a:b","c","owns:part","a","b:c"]'
    )
  })

  test("normalizes edit intent without reordering operations", () => {
    const normalized = normalizeOntologyEditCommit({
      mode: "atomic",
      source: { kind: "runtime", requestId: "request-1" },
      operations: [
        {
          id: "first",
          kind: "object.patch",
          ref: leftObject,
          set: { z: 1, a: null },
          unset: ["zeta", "beta"],
          reset: ["gamma"],
        },
        { id: "second", kind: "object.delete", ref: rightObject },
      ],
      expectedObjects: [
        { ref: rightObject, exists: false },
        { ref: rightObject, exists: false },
      ],
      expectedLinks: [],
      expectedLinkScopes: [],
    })

    expect(normalized.operations.map((operation) => operation.id)).toEqual(["first", "second"])
    const first = normalized.operations[0]
    expect(first.kind).toBe("object.patch")
    if (first.kind !== "object.patch") throw new Error("unexpected operation")
    expect(Object.keys(first.set)).toEqual(["a", "z"])
    expect(first.unset).toEqual(["beta", "zeta"])
    expect(normalized.mode === "atomic" && normalized.expectedObjects).toHaveLength(1)
  })

  test("rejects duplicate operation ids and contradictory expectations", () => {
    expect(() =>
      normalizeOntologyEditCommit({
        mode: "continue",
        source: { kind: "runtime", requestId: "request-1" },
        operations: [
          { id: "same", kind: "object.delete", ref: leftObject },
          { id: "same", kind: "object.restore", ref: leftObject },
        ],
      })
    ).toThrow("[Sixb] Duplicate operation id 'same'.")

    expect(() =>
      normalizeOntologyEditCommit({
        mode: "atomic",
        source: { kind: "runtime", requestId: "request-1" },
        operations: [],
        expectedObjects: [
          { ref: leftObject, exists: false },
          { ref: leftObject, exists: true, version: 1, lastCommitId: "commit-1" },
        ],
        expectedLinks: [],
        expectedLinkScopes: [],
      })
    ).toThrow("contradictory")
  })

  test("requires matching projection root assertions", () => {
    expect(() =>
      normalizeProjectionSourceEntry({
        root: { kind: "object", ref: leftObject },
        assertions: [{ kind: "object", ref: rightObject, properties: {} }],
      })
    ).toThrow("must contain an assertion matching root")

    expect(() =>
      normalizeProjectionSourceEntry({
        root: { kind: "object", ref: leftObject },
        assertions: [
          { kind: "object", ref: leftObject, properties: {} },
          { kind: "object", ref: rightObject, properties: {} },
        ],
      })
    ).toThrow("exactly its matching object assertion plus links")

    expect(() =>
      normalizeProjectionSourceEntry({
        root: { kind: "object", ref: leftObject },
        assertions: [
          { kind: "object", ref: leftObject, properties: {} },
          {
            kind: "link",
            ref: { source: rightObject, linkId: "related", target: leftObject },
          },
        ],
      })
    ).toThrow("only links sourced from that root")

    const linkRef = { source: leftObject, linkId: "related", target: rightObject }
    expect(() =>
      normalizeProjectionSourceEntry({
        root: { kind: "link", ref: linkRef },
        assertions: [
          { kind: "link", ref: linkRef },
          { kind: "object", ref: leftObject, properties: {} },
        ],
      })
    ).toThrow("exactly its matching link assertion")
  })

  test("normalizes actors to the exact persisted shape", () => {
    const normalized = normalizeOntologyEditCommit({
      mode: "continue",
      source: { kind: "runtime", requestId: "request-1" },
      actor: { type: "service", id: "service-1", ignored: true },
      operations: [],
    } as Parameters<typeof normalizeOntologyEditCommit>[0] & {
      actor: { type: "service"; id: string; ignored: boolean }
    })
    expect(normalized.actor).toEqual({ type: "service", id: "service-1" })
    expect(Object.keys(normalized.actor ?? {})).toEqual(["type", "id"])

    expect(() =>
      normalizeOntologyEditCommit({
        mode: "continue",
        source: { kind: "runtime", requestId: "request-1" },
        actor: { type: "robot", id: "service-1" },
        operations: [],
      } as unknown as Parameters<typeof normalizeOntologyEditCommit>[0])
    ).toThrow("Event actor type")
    expect(() =>
      normalizeOntologyEditCommit({
        mode: "continue",
        source: { kind: "runtime", requestId: "request-1" },
        actor: { type: "system", id: "  " },
        operations: [],
      })
    ).toThrow("Event actor id must be a nonblank string")
  })

  test("collapses equal telemetry duplicates and rejects conflicting points", () => {
    const point = {
      series: { object: leftObject, propertyId: "temperature" },
      value: 21,
      at: "2026-01-02T03:04:05Z",
    }
    const normalized = normalizeTelemetryAppend({
      source: { kind: "runtime", requestId: "request-1" },
      points: [point, { ...point }],
    })
    expect(normalized.points).toHaveLength(1)
    expect(normalized.points[0].at).toBe("2026-01-02T03:04:05.000Z")

    expect(() =>
      normalizeTelemetryAppend({
        source: { kind: "runtime", requestId: "request-1" },
        points: [point, { ...point, value: 22 }],
      })
    ).toThrow("Conflicting telemetry points")

    const projectionAppend = normalizeTelemetryAppend({
      source: {
        kind: "projection",
        projection: { projectionId: "temperatures" },
        datasetVersion: {
          datasetId: "readings",
          versionId: "version-1",
          createdAt: "2026-01-02T03:04:05Z",
        },
        execution: { projectionRunId: "run-1", executionToken: "execution-1" },
        batchOrdinal: 2,
        sourceRowCount: 1,
        inputExhausted: true,
      },
      points: [point],
    })
    expect(
      projectionAppend.source.kind === "projection" && projectionAppend.source.batchOrdinal
    ).toBe(2)
  })

  test("freezes provider staging and telemetry checkpoint shapes", () => {
    const staged = {
      root: { kind: "object", ref: leftObject },
      assertion: { kind: "object", ref: leftObject, properties: {} },
      stagingOrdinal: 3,
    } satisfies StageSourceAssertion
    expect(Object.keys(staged)).toEqual(["root", "assertion", "stagingOrdinal"])

    const checkpoint = {
      id: "run-1",
      projectId: "project",
      executionToken: "execution-1",
      identity: {
        projectionId: "temperatures",
        projectionKind: "telemetry",
        protocol: "telemetry",
        datasetVersion: {
          datasetId: "readings",
          versionId: "version-1",
          createdAt: "2026-01-02T03:04:05.000Z",
        },
        ontologyRevision: "ontology-1",
        projectionRevision: "revision-1",
        ownershipHash: "ownership-1",
      },
      batchOrdinal: 4,
      batchRowCount: 512,
      inputExhausted: false,
    } satisfies AdvanceProjectionTelemetryCheckpointInput
    expect(checkpoint.batchRowCount).toBe(512)

    type ActiveSource = Awaited<ReturnType<OntologySourceStorage["getActive"]>>
    const activeSource: ActiveSource = null
    expect(activeSource).toBeNull()
  })

  test("lets providers construct opaque sessions and rejects inactive handles", async () => {
    const provider = new FakeMaterializationStorage()
    const header = {
      commit: {
        projectId: "project",
        id: "commit-1",
        idempotencyKey: "runtime:request-1",
        requestHash: "request-hash",
        origin: { kind: "runtime", requestId: "request-1" },
        ontologyRevision: "ontology-revision",
        intent: { kind: "edit", mode: "atomic", operationCount: 0 },
        committedAt: "2026-01-02T03:04:05.000Z",
      },
      expected: {
        sources: [],
        objects: [],
        links: [],
        linkScopes: [],
        points: [],
      },
    } satisfies MaterializationPlanHeader
    const session = await provider.begin(header)
    expect(Object.keys(session)).toEqual(["providerToken"])

    const emptyChunk = {
      overrides: { objectUpserts: [], objectDeletes: [], linkUpserts: [], linkDeletes: [] },
      effective: { objectUpserts: [], objectDeletes: [], linkUpserts: [], linkDeletes: [] },
      timeseries: { pointUpserts: [] },
      outbox: [],
    } as const
    await expect(provider.applyChunk({ session, chunk: emptyChunk })).resolves.toBeUndefined()

    const inactiveSession: MaterializationSession = { providerToken: {} }
    await expect(
      provider.applyChunk({ session: inactiveSession, chunk: emptyChunk })
    ).rejects.toThrow("Inactive materialization session")
  })

  test("correlates finalized commits and returns one authoritative result", () => {
    const write = {
      projectId: "project",
      id: "commit-1",
      idempotencyKey: "runtime:request-1",
      requestHash: "request-hash",
      origin: { kind: "runtime", requestId: "request-1" },
      ontologyRevision: "ontology-revision",
      intent: { kind: "edit", mode: "atomic", operationCount: 0 },
      committedAt: "2026-01-02T03:04:05.000Z",
    } satisfies OntologyCommitWrite
    const result = {
      kind: "edit",
      commitId: "commit-1",
      created: true,
      eventCount: 0,
      outcomes: [],
      changes: { objects: [], links: [] },
    } as const
    const record = { ...write, result } satisfies OntologyCommitRecord
    const applied = { commit: record } satisfies ApplyMaterializationResult

    expect(Object.keys(write)).not.toContain("result")
    expect(applied.commit.result).toBe(result)
    expect(Object.keys(applied)).toEqual(["commit"])

    // @ts-expect-error An edit commit cannot finalize with a telemetry result.
    const mismatched: OntologyCommitRecord = {
      ...write,
      result: {
        kind: "telemetry",
        commitId: "commit-1",
        created: true,
        eventCount: 0,
        pointsCreated: 0,
        pointsUpdated: 0,
        pointsUnchanged: 0,
        latestObjectsChanged: 0,
      },
    }
    expect(mismatched.result.kind).toBe("telemetry")
  })

  test("uses the outbox envelope as event identity authority", () => {
    const envelope: OntologyMaterializationEvent = {
      id: "event-1",
      schemaVersion: 1,
      projectId: "project",
      occurredAt: "2026-01-02T03:04:05.000Z",
      origin: { kind: "runtime", requestId: "request-1" },
      commitId: "commit-1",
      commitOrdinal: 0,
      type: "object.deleted",
      topic: "objects",
      partitionKey: "Entity:1",
      payload: {
        objectTypeId: "Entity",
        primaryId: "1",
        propertyChanges: {},
      },
    }
    const write = {
      envelope,
      availableAt: "2026-01-02T03:04:05.000Z",
      createdAt: "2026-01-02T03:04:05.000Z",
    } satisfies OntologyOutboxWrite

    expect(Object.keys(write)).toEqual(["envelope", "availableAt", "createdAt"])
    expect(write.envelope.id).toBe("event-1")
    expect(write.envelope.commitId).toBe("commit-1")
    expect(write.envelope.commitOrdinal).toBe(0)
  })

  test("derives stable SHA-256 commit and event identities", () => {
    expect(sha256Canonical({ b: 2, a: 1 })).toBe(sha256Canonical({ a: 1, b: 2 }))
    expect(sha256Canonical({ a: 1 })).toMatch(/^[0-9a-f]{64}$/)
    expect(() => sha256Canonical({ invalid: undefined })).toThrow(
      "Canonical hash input must be a JSON value; Canonical hash input.invalid is undefined"
    )
    expect(() => sha256Canonical(new Date())).toThrow("Canonical hash input must be a JSON value")
    expect(createCommitId("project", "runtime:request")).toBe(
      createCommitId("project", "runtime:request")
    )
    expect(createEventId("project", "commit", 1)).not.toBe(createEventId("project", "commit", 2))
    expect(
      createTimedCommitIdentity({
        projectId: "project",
        idempotencyKey: "runtime:request",
        normalizedCallerIntent: { operation: "empty" },
        now: new Date("2026-01-02T03:04:05.000Z"),
      })
    ).toEqual({
      idempotencyKey: "runtime:request",
      requestHash: sha256Canonical({ operation: "empty" }),
      commitId: createCommitId("project", "runtime:request"),
      committedAt: "2026-01-02T03:04:05.000Z",
    })
  })

  test("freezes persisted event ordering, origin, and commit ordinal", () => {
    const event: OntologyMaterializationEvent = {
      id: "event-1",
      schemaVersion: 1,
      projectId: "project",
      occurredAt: "2026-01-02T03:04:05.000Z",
      origin: { kind: "runtime", requestId: "request-1" },
      commitId: "commit-1",
      commitOrdinal: 0,
      type: "object.updated",
      topic: "objects",
      partitionKey: "Entity:1",
      payload: {
        objectTypeId: "Entity",
        primaryId: "1",
        properties: { name: "after" },
        propertyChanges: {
          obsolete: { operation: "cleared", before: "old", after: null },
        },
      },
    }

    expect(event.payload.propertyChanges.obsolete?.operation).toBe("cleared")
    expect(ONTOLOGY_MATERIALIZATION_EVENT_KIND_ORDER).toEqual([
      "object.created",
      "object.updated",
      "object.deleted",
      "link.created",
      "link.updated",
      "link.deleted",
      "telemetry.appended",
    ])
  })

  test("keeps bounded batching under the hood", () => {
    expect(resolveMaterializationBatching()).toEqual(DEFAULT_MATERIALIZATION_BATCHING)
    expect(resolveMaterializationBatching({ statePageRows: 2 }).statePageRows).toBe(2)
    expect(() => resolveMaterializationBatching({ planChunkRows: 0 })).toThrow(
      "must be a positive safe integer"
    )
  })

  test("uses UTF-8 bytes for plan chunk thresholds", async () => {
    const item = {
      kind: "object-override-delete" as const,
      value: {
        ref: { objectTypeId: "Device", primaryId: "😀" },
        expectedLastCommitId: "previous",
      },
    }
    const utf8Bytes = new TextEncoder().encode(JSON.stringify(item)).byteLength
    const chunks = []
    for await (const chunk of planStream([item, item], {
      ...DEFAULT_MATERIALIZATION_BATCHING,
      planChunkRows: 10,
      planChunkBytes: utf8Bytes * 2 - 1,
    })) {
      chunks.push(chunk)
    }
    expect(chunks).toHaveLength(2)
    expect(chunks.map((chunk) => chunk.overrides.objectDeletes.length)).toEqual([1, 1])
  })

  test("does not expose materializer values or tuning from the package root", () => {
    expect("OntologyMaterializer" in rootExports).toBe(false)
    expect("ProjectionRegistry" in rootExports).toBe(false)
    expect("InMemoryOntologyStorage" in rootExports).toBe(false)
    expect("MaterializationOptions" in rootExports).toBe(false)
    expect("MaterializationBatching" in rootExports).toBe(false)
    expect("sha256Canonical" in rootExports).toBe(false)
  })
})
