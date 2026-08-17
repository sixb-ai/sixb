import { describe, expect, test } from "bun:test"
import { InMemoryStorage } from "../src"
import { linkRefSortKey, linkScopeSortKey } from "../src/materialization/refs"
import type {
  MaterializationCardinalityOccupantWorkRecord,
  MaterializationPlanChunk,
  MaterializationPlanFinalization,
  MaterializationPlanHeader,
  MaterializationPlanWorkRecord,
  MaterializationSession,
  MaterializationStatePage,
  OntologyMaterializationStorage,
  ProjectionRunClaim,
} from "../src/storage"
import { startTestProjectionRun } from "../src/testing"
import { createMaterializerFixture } from "./materializer-fixture"

const projectId = "project"
const ontologyRevision = "ontology-revision"
const projectionRevision = "projection-revision"
const ownershipHash = "ownership-hash"

type ReplacementKind = "object" | "link"

interface CandidateFixture {
  readonly source: { readonly projectionId: string }
  readonly materializationId: string
  readonly projectionKind: ReplacementKind
  readonly execution: { readonly projectionRunId: string; readonly executionToken: string }
  readonly datasetVersion: {
    readonly datasetId: string
    readonly versionId: string
    readonly createdAt: string
  }
  readonly readyAt: string
}

async function prepareEmptyCandidate(
  storage: InMemoryStorage,
  input: {
    readonly projectionId: string
    readonly datasetId?: string
    readonly projectionKind: ReplacementKind
    readonly runId: string
    readonly materializationId: string
    readonly versionId: string
    readonly datasetCreatedAt: string
    readonly candidateCreatedAt: string
    readonly readyAt: string
  }
): Promise<CandidateFixture> {
  const source = { projectionId: input.projectionId }
  const datasetVersion = {
    datasetId: input.datasetId ?? input.projectionId,
    versionId: input.versionId,
    createdAt: input.datasetCreatedAt,
  }
  let run: ProjectionRunClaim
  const common = { id: input.runId, projectId }
  if (input.projectionKind === "object") {
    run = await startTestProjectionRun(storage, {
      ...common,
      identity: {
        projectionId: input.projectionId,
        projectionKind: "object",
        protocol: "replacement",
        datasetVersion,
        ontologyRevision,
        projectionRevision,
        ownershipHash,
      },
      target: { objectTypeId: "Device" },
    })
  } else {
    run = await startTestProjectionRun(storage, {
      ...common,
      identity: {
        projectionId: input.projectionId,
        projectionKind: "link",
        protocol: "replacement",
        datasetVersion,
        ontologyRevision,
        projectionRevision,
        ownershipHash,
      },
      target: { sourceObjectTypeId: "Device", targetObjectTypeId: "Device" },
    })
  }
  const execution = run.execution
  await storage.ontology.sources.beginMaterialization({
    projectId,
    source,
    materializationId: input.materializationId,
    execution,
    projectionKind: input.projectionKind,
    protocol: "replacement",
    datasetVersion,
    ontologyRevision,
    projectionRevision,
    ownershipHash,
    createdAt: input.candidateCreatedAt,
  })
  await storage.ontology.sources.markReady({
    projectId,
    source,
    materializationId: input.materializationId,
    execution,
    rootCount: 0,
    assertionCount: 0,
    readyAt: input.readyAt,
  })
  return {
    source,
    materializationId: input.materializationId,
    projectionKind: input.projectionKind,
    execution,
    datasetVersion,
    readyAt: input.readyAt,
  }
}

function replacementHeader(
  candidate: CandidateFixture,
  commitId: string,
  committedAt: string,
  active: { readonly materializationId: string; readonly commitId: string } | null = null
): MaterializationPlanHeader {
  return {
    commit: {
      projectId,
      id: commitId,
      idempotencyKey: `projection:${commitId}`,
      requestHash: commitId,
      origin: {
        kind: "projection",
        projectionId: candidate.source.projectionId,
        projectionRunId: candidate.execution.projectionRunId,
        datasetId: candidate.datasetVersion.datasetId,
        datasetVersionId: candidate.datasetVersion.versionId,
      },
      ontologyRevision,
      projectionRevision,
      ownershipHash,
      intent: {
        kind: "projection",
        source: candidate.source,
        datasetVersion: candidate.datasetVersion,
      },
      committedAt,
    },
    expected: {
      sources: [
        {
          source: candidate.source,
          activeMaterializationId: active?.materializationId ?? null,
          lastCommitId: active?.commitId ?? null,
        },
      ],
      objects: [],
      links: [],
      linkScopes: [],
      points: [],
    },
  }
}

function replacementFinalization(
  candidate: CandidateFixture,
  header: MaterializationPlanHeader
): MaterializationPlanFinalization {
  if (header.commit.intent.kind !== "projection") throw new Error("Expected projection intent")
  const counts = {
    objectsCreated: 0,
    objectsUpdated: 0,
    objectsDeleted: 0,
    objectsUnchanged: 0,
    linksCreated: 0,
    linksUpdated: 0,
    linksDeleted: 0,
    linksUnchanged: 0,
  }
  return {
    sourceActivations: [
      {
        source: candidate.source,
        materializationId: candidate.materializationId,
        execution: candidate.execution,
        projectionKind: candidate.projectionKind,
        protocol: "replacement",
        datasetVersion: candidate.datasetVersion,
        ontologyRevision,
        projectionRevision,
        ownershipHash,
        expected: header.expected.sources[0],
        lastCommitId: header.commit.id,
        updatedAt: header.commit.committedAt,
      },
    ],
    result: {
      kind: "projection",
      commitId: header.commit.id,
      created: true,
      eventCount: 0,
      committedAt: header.commit.committedAt,
      counts,
    },
  }
}

async function drainReplacementState(
  materializations: OntologyMaterializationStorage,
  session: MaterializationSession,
  candidate: CandidateFixture
): Promise<void> {
  if (candidate.projectionKind === "object") {
    for await (const _page of materializations.streamSourceReplacementState({
      session,
      source: candidate.source,
      candidateMaterializationId: candidate.materializationId,
      entityKind: "object",
      pageRows: 1,
    })) {
      // Empty candidates still have to exhaust the lane.
    }
  }
  for await (const _page of materializations.streamSourceReplacementState({
    session,
    source: candidate.source,
    candidateMaterializationId: candidate.materializationId,
    entityKind: "link",
    pageRows: 1,
  })) {
    // Empty candidates still have to exhaust the lane.
  }
}

function emptyEditHeader(commitId: string): MaterializationPlanHeader {
  return {
    commit: {
      projectId,
      id: commitId,
      idempotencyKey: `runtime:${commitId}`,
      requestHash: commitId,
      origin: { kind: "runtime", requestId: commitId },
      ontologyRevision,
      intent: { kind: "edit", mode: "atomic", operationCount: 0 },
      committedAt: "2026-01-01T00:00:00.000Z",
    },
    expected: { sources: [], objects: [], links: [], linkScopes: [], points: [] },
  }
}

function emptyEditFinalization(header: MaterializationPlanHeader): MaterializationPlanFinalization {
  return {
    sourceActivations: [],
    result: {
      kind: "edit",
      commitId: header.commit.id,
      created: true,
      eventCount: 0,
      committedAt: header.commit.committedAt,
      outcomes: [],
      changes: { objects: [], links: [] },
    },
  }
}

function objectUpsertWork(
  header: MaterializationPlanHeader,
  primaryId: string,
  sortKey: string
): MaterializationPlanWorkRecord {
  return {
    kind: "plan",
    recordKey: `plan:object-upsert:${sortKey}`,
    applyPhase: 4,
    sortKey,
    item: {
      kind: "object-upsert",
      value: {
        row: {
          ref: { objectTypeId: "Device", primaryId },
          properties: { name: primaryId },
          version: 1,
          createdAt: header.commit.committedAt,
          updatedAt: header.commit.committedAt,
          lastCommitId: header.commit.id,
        },
        expected: {
          ref: { objectTypeId: "Device", primaryId },
          exists: false,
        },
      },
    },
  }
}

function objectUpsertChunk(
  records: readonly MaterializationPlanWorkRecord[]
): MaterializationPlanChunk {
  return {
    overrides: {
      objects: { upserts: [], deletes: [] },
      links: {
        edges: { upserts: [], deletes: [] },
        slots: { upserts: [], deletes: [] },
      },
    },
    effective: {
      objectUpserts: records.map((record) => {
        if (record.item.kind !== "object-upsert") throw new Error("Expected object upsert")
        return record.item.value
      }),
      objectDeletes: [],
      linkUpserts: [],
      linkDeletes: [],
    },
    timeseries: { pointUpserts: [] },
    outbox: [],
  }
}

describe("in-memory ontology materialization finalization", () => {
  test("rejects ontology sessions inherited from a completed transaction", async () => {
    const storage = new InMemoryStorage()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let inheritedBegin: Promise<MaterializationSession> | undefined

    await storage.transaction(() => {
      inheritedBegin = gate.then(() =>
        storage.ontology.materializations.begin(emptyEditHeader("stale-transaction-context"))
      )
    })
    release()

    if (!inheritedBegin) throw new Error("Expected inherited session attempt")
    await expect(inheritedBegin).rejects.toThrow("require an active storage transaction")
  })

  test("invalidates partially consumed streams when their transaction closes", async () => {
    const storage = new InMemoryStorage()
    let leaked: AsyncIterator<MaterializationStatePage> | undefined

    await expect(
      storage.transaction(async (tx) => {
        if (!tx.ontology) throw new Error("missing ontology")
        const session = await tx.ontology.materializations.begin(emptyEditHeader("leaked-stream"))
        const requests = (async function* () {
          yield {
            objects: [
              { objectTypeId: "Device", primaryId: "one" },
              { objectTypeId: "Device", primaryId: "two" },
            ],
            links: [],
            linkScopes: [],
            incidentObjects: [],
            points: [],
          }
        })()
        leaked = tx.ontology.materializations
          .streamState({ session, requests, pageRows: 1 })
          [Symbol.asyncIterator]()
        expect((await leaked.next()).done).toBe(false)
      })
    ).rejects.toThrow("unfinished materialization session")

    if (!leaked) throw new Error("Expected leaked iterator")
    await expect(leaked.next()).rejects.toThrow("session is inactive")
  })

  test("requires every replacement lane even when the object projection is empty", async () => {
    const storage = new InMemoryStorage()
    const candidate = await prepareEmptyCandidate(storage, {
      projectionId: "devices",
      projectionKind: "object",
      runId: "empty-object-run",
      materializationId: "empty-object-candidate",
      versionId: "v1",
      datasetCreatedAt: "2026-01-01T00:00:00.000Z",
      candidateCreatedAt: "2026-01-02T00:00:00.000Z",
      readyAt: "2026-01-02T00:01:00.000Z",
    })
    const header = replacementHeader(candidate, "empty-object-commit", "2026-01-03T00:00:00.000Z")
    await expect(
      storage.transaction(async (tx) => {
        if (!tx.ontology) throw new Error("missing ontology")
        const session = await tx.ontology.materializations.begin(header)
        for await (const _page of tx.ontology.materializations.streamSourceReplacementState({
          session,
          source: candidate.source,
          candidateMaterializationId: candidate.materializationId,
          entityKind: "object",
          pageRows: 1,
        })) {
          // Intentionally omit the required link lane.
        }
        await tx.ontology.materializations.finalize({
          session,
          finalization: replacementFinalization(candidate, header),
        })
      })
    ).rejects.toThrow("not fully streamed")
  })

  test("requires only the link lane for an empty link projection", async () => {
    const storage = new InMemoryStorage()
    const candidate = await prepareEmptyCandidate(storage, {
      projectionId: "device-links",
      projectionKind: "link",
      runId: "empty-link-run",
      materializationId: "empty-link-candidate",
      versionId: "v1",
      datasetCreatedAt: "2026-01-01T00:00:00.000Z",
      candidateCreatedAt: "2026-01-02T00:00:00.000Z",
      readyAt: "2026-01-02T00:01:00.000Z",
    })
    const header = replacementHeader(candidate, "empty-link-commit", "2026-01-03T00:00:00.000Z")
    await storage.transaction(async (tx) => {
      if (!tx.ontology) throw new Error("missing ontology")
      const session = await tx.ontology.materializations.begin(header)
      await drainReplacementState(tx.ontology.materializations, session, candidate)
      await tx.ontology.materializations.finalize({
        session,
        finalization: replacementFinalization(candidate, header),
      })
    })
    expect(
      await storage.ontology.sources.getActive({ projectId, source: candidate.source })
    ).toMatchObject({
      materializationId: candidate.materializationId,
      projectionKind: "link",
      protocol: "replacement",
    })
  })

  test("requires exact replacement and telemetry classification coverage", async () => {
    const storage = new InMemoryStorage()
    const candidate = await prepareEmptyCandidate(storage, {
      projectionId: "device-links",
      projectionKind: "link",
      runId: "classification-run",
      materializationId: "classification-candidate",
      versionId: "v1",
      datasetCreatedAt: "2026-01-01T00:00:00.000Z",
      candidateCreatedAt: "2026-01-02T00:00:00.000Z",
      readyAt: "2026-01-02T00:01:00.000Z",
    })
    const header = replacementHeader(candidate, "classification-commit", "2026-01-03T00:00:00.000Z")
    await expect(
      storage.transaction(async (tx) => {
        if (!tx.ontology) throw new Error("missing ontology")
        const session = await tx.ontology.materializations.begin(header)
        await drainReplacementState(tx.ontology.materializations, session, candidate)
        await tx.ontology.materializations.stageWork({
          session,
          records: [
            {
              kind: "classification",
              recordKey: "classification:link:61",
              entityKind: "link",
              identityKey: "unexpected-link",
            },
          ],
        })
        await tx.ontology.materializations.finalize({
          session,
          finalization: replacementFinalization(candidate, header),
        })
      })
    ).rejects.toThrow("classification coverage")

    const telemetryHeader: MaterializationPlanHeader = {
      commit: {
        projectId,
        id: "telemetry-classification",
        idempotencyKey: "runtime:telemetry-classification",
        requestHash: "telemetry-classification",
        origin: {
          kind: "telemetry",
          source: { kind: "runtime", requestId: "telemetry-classification" },
        },
        ontologyRevision,
        intent: {
          kind: "telemetry",
          pointCount: 1,
          inputPointCount: 1,
          source: { kind: "runtime" },
        },
        committedAt: "2026-01-03T00:00:00.000Z",
      },
      expected: { sources: [], objects: [], links: [], linkScopes: [], points: [] },
    }
    await expect(
      storage.transaction(async (tx) => {
        if (!tx.ontology) throw new Error("missing ontology")
        const session = await tx.ontology.materializations.begin(telemetryHeader)
        await tx.ontology.materializations.finalize({
          session,
          finalization: {
            sourceActivations: [],
            result: {
              kind: "telemetry",
              commitId: telemetryHeader.commit.id,
              created: true,
              eventCount: 0,
              committedAt: telemetryHeader.commit.committedAt,
              pointsCreated: 0,
              pointsUpdated: 0,
              pointsUnchanged: 1,
              latestObjectsChanged: 0,
            },
          },
        })
      })
    ).rejects.toThrow("point classification coverage")
  })

  test("rejects unapplied plan work and undelivered staged events", async () => {
    const storage = new InMemoryStorage()
    const planHeader = emptyEditHeader("unapplied-plan")
    await expect(
      storage.transaction(async (tx) => {
        if (!tx.ontology) throw new Error("missing ontology")
        const session = await tx.ontology.materializations.begin(planHeader)
        await tx.ontology.materializations.stageWork({
          session,
          records: [
            {
              kind: "plan",
              recordKey: "plan:object-upsert:61",
              applyPhase: 4,
              sortKey: "61",
              item: {
                kind: "object-upsert",
                value: {
                  row: {
                    ref: { objectTypeId: "Device", primaryId: "one" },
                    properties: { name: "one" },
                    version: 1,
                    createdAt: planHeader.commit.committedAt,
                    updatedAt: planHeader.commit.committedAt,
                    lastCommitId: planHeader.commit.id,
                  },
                  expected: {
                    ref: { objectTypeId: "Device", primaryId: "one" },
                    exists: false,
                  },
                },
              },
            },
          ],
        })
        for await (const _page of tx.ontology.materializations.streamWork({
          session,
          order: "apply",
          pageRows: 1,
        })) {
          // Intentionally do not apply the streamed exact plan.
        }
        await tx.ontology.materializations.finalize({
          session,
          finalization: emptyEditFinalization(planHeader),
        })
      })
    ).rejects.toThrow("not applied exactly once")

    const eventHeader = emptyEditHeader("undelivered-event")
    await expect(
      storage.transaction(async (tx) => {
        if (!tx.ontology) throw new Error("missing ontology")
        const session = await tx.ontology.materializations.begin(eventHeader)
        await tx.ontology.materializations.stageWork({
          session,
          records: [
            {
              kind: "event",
              recordKey: "event:0:61",
              eventKindRank: 0,
              sortKey: "61",
              draft: {
                schemaVersion: 1,
                projectId,
                occurredAt: eventHeader.commit.committedAt,
                origin: eventHeader.commit.origin,
                commitId: eventHeader.commit.id,
                type: "object.created",
                topic: "objects",
                partitionKey: "Device:one",
                payload: {
                  objectTypeId: "Device",
                  primaryId: "one",
                  properties: { name: "one" },
                  propertyChanges: {},
                },
              },
            },
          ],
        })
        for await (const _page of tx.ontology.materializations.streamWork({
          session,
          order: "event",
          pageRows: 1,
        })) {
          // Intentionally do not materialize the staged event into the outbox.
        }
        await tx.ontology.materializations.finalize({
          session,
          finalization: emptyEditFinalization(eventHeader),
        })
      })
    ).rejects.toThrow("not fully written to the outbox")
  })

  test("applies only plan items already emitted by the provider, in exact order", async () => {
    const storage = new InMemoryStorage()
    const header = emptyEditHeader("ordered-plan")
    const first = objectUpsertWork(header, "one", "61")
    const second = objectUpsertWork(header, "two", "62")

    await expect(
      storage.transaction(async (tx) => {
        if (!tx.ontology) throw new Error("missing ontology")
        const session = await tx.ontology.materializations.begin(header)
        await tx.ontology.materializations.stageWork({ session, records: [first, second] })

        await expect(
          tx.ontology.materializations.applyChunk({
            session,
            chunk: objectUpsertChunk([first]),
          })
        ).rejects.toThrow("before they are streamed")

        for await (const _page of tx.ontology.materializations.streamWork({
          session,
          order: "apply",
          pageRows: 2,
        })) {
          // Drain the canonical provider order before trying an inverted chunk.
        }
        await expect(
          tx.ontology.materializations.applyChunk({
            session,
            chunk: objectUpsertChunk([second, first]),
          })
        ).rejects.toThrow("exact streamed order")
      })
    ).rejects.toThrow("unfinished materialization session")

    expect(
      await storage.objects.getByPrimaryId({
        projectId,
        objectTypeId: "Device",
        primaryId: "one",
      })
    ).toBeNull()
    expect(
      await storage.objects.getByPrimaryId({
        projectId,
        objectTypeId: "Device",
        primaryId: "two",
      })
    ).toBeNull()
  })

  test("revalidates cardinality mechanically at finalization", async () => {
    const storage = new InMemoryStorage()
    const header = emptyEditHeader("cardinality-seal")
    const sourceRef = { objectTypeId: "Device", primaryId: "one" }
    const records: MaterializationCardinalityOccupantWorkRecord[] = ["two", "three"].map(
      (primaryId) => {
        const ref = {
          source: sourceRef,
          linkId: "parent",
          target: { objectTypeId: "Device", primaryId },
        }
        return {
          kind: "cardinality",
          recordKey: `cardinality:${primaryId}`,
          view: "effective",
          scopeSortKey: linkScopeSortKey(sourceRef, "parent"),
          linkSortKey: linkRefSortKey(ref),
          ref,
          occupied: true,
        }
      }
    )

    await expect(
      storage.transaction(async (tx) => {
        if (!tx.ontology) throw new Error("missing ontology")
        const session = await tx.ontology.materializations.begin(header)
        await tx.ontology.materializations.stageWork({ session, records })
        for await (const _page of tx.ontology.materializations.streamWork({
          session,
          order: "cardinality",
          pageRows: 2,
        })) {
          // A malicious/buggy consumer drains without running its own validation.
        }
        await tx.ontology.materializations.finalize({
          session,
          finalization: emptyEditFinalization(header),
        })
      })
    ).rejects.toThrow("violates cardinality-one")
  })

  test("rescans final link scopes instead of trusting staged occupancy", async () => {
    const storage = new InMemoryStorage()
    const header = emptyEditHeader("cardinality-rescan")
    const ref = {
      source: { objectTypeId: "Device", primaryId: "one" },
      linkId: "parent",
      target: { objectTypeId: "Device", primaryId: "two" },
    }
    const { materializer } = createMaterializerFixture({ storage })
    await materializer.edits.commit({
      mode: "atomic",
      source: { kind: "runtime", requestId: "existing-link" },
      operations: [
        {
          id: "create-one",
          kind: "object.create",
          ref: ref.source,
          properties: { name: "One" },
        },
        {
          id: "create-two",
          kind: "object.create",
          ref: ref.target,
          properties: { name: "Two" },
        },
        { id: "existing-link", kind: "link.upsert", ref },
      ],
      expectedObjects: [],
      expectedLinks: [],
      expectedLinkScopes: [],
    })

    await expect(
      storage.transaction(async (tx) => {
        if (!tx.ontology) throw new Error("missing ontology")
        const session = await tx.ontology.materializations.begin(header)
        await tx.ontology.materializations.stageWork({
          session,
          records: [
            {
              kind: "cardinality",
              recordKey: "cardinality:dishonest-empty-scope",
              view: "effective",
              scopeSortKey: linkScopeSortKey(ref.source, ref.linkId),
              linkSortKey: linkRefSortKey(ref),
              ref,
              occupied: false,
            },
          ],
        })
        for await (const _page of tx.ontology.materializations.streamWork({
          session,
          order: "cardinality",
          pageRows: 1,
        })) {
          // Deliberately trust the dishonest record; finalization must inspect the durable scope.
        }
        await tx.ontology.materializations.finalize({
          session,
          finalization: emptyEditFinalization(header),
        })
      })
    ).rejects.toThrow("does not match the final effective link scope")
  })

  test("rejects activation of a candidate other than the one opened by the session", async () => {
    const storage = new InMemoryStorage()
    const opened = await prepareEmptyCandidate(storage, {
      projectionId: "devices",
      projectionKind: "object",
      runId: "opened-run",
      materializationId: "opened-candidate",
      versionId: "v1",
      datasetCreatedAt: "2026-01-01T00:00:00.000Z",
      candidateCreatedAt: "2026-01-02T00:00:00.000Z",
      readyAt: "2026-01-02T00:01:00.000Z",
    })
    const activated = await prepareEmptyCandidate(storage, {
      projectionId: "devices",
      projectionKind: "object",
      runId: "activated-run",
      materializationId: "activated-candidate",
      versionId: "v2",
      datasetCreatedAt: "2026-01-02T00:00:00.000Z",
      candidateCreatedAt: "2026-01-02T00:02:00.000Z",
      readyAt: "2026-01-02T00:03:00.000Z",
    })
    const header = replacementHeader(
      activated,
      "wrong-candidate-commit",
      "2026-01-03T00:00:00.000Z"
    )
    await expect(
      storage.transaction(async (tx) => {
        if (!tx.ontology) throw new Error("missing ontology")
        const session = await tx.ontology.materializations.begin(header)
        await drainReplacementState(tx.ontology.materializations, session, opened)
        await tx.ontology.materializations.finalize({
          session,
          finalization: replacementFinalization(activated, header),
        })
      })
    ).rejects.toThrow("candidate opened by the session")
  })

  test("rejects activation before candidate readiness or the prior active update", async () => {
    const storage = new InMemoryStorage()
    const first = await prepareEmptyCandidate(storage, {
      projectionId: "devices",
      projectionKind: "object",
      runId: "first-run",
      materializationId: "first-candidate",
      versionId: "v1",
      datasetCreatedAt: "2026-01-01T00:00:00.000Z",
      candidateCreatedAt: "2026-01-01T00:00:00.000Z",
      readyAt: "2026-01-01T01:00:00.000Z",
    })
    const tooEarlyHeader = replacementHeader(
      first,
      "before-ready-commit",
      "2026-01-01T00:30:00.000Z"
    )
    await expect(
      storage.transaction(async (tx) => {
        if (!tx.ontology) throw new Error("missing ontology")
        const session = await tx.ontology.materializations.begin(tooEarlyHeader)
        await drainReplacementState(tx.ontology.materializations, session, first)
        await tx.ontology.materializations.finalize({
          session,
          finalization: replacementFinalization(first, tooEarlyHeader),
        })
      })
    ).rejects.toThrow("cannot precede candidate readiness")

    const firstHeader = replacementHeader(first, "first-commit", "2026-01-03T00:00:00.000Z")
    await storage.transaction(async (tx) => {
      if (!tx.ontology) throw new Error("missing ontology")
      const session = await tx.ontology.materializations.begin(firstHeader)
      await drainReplacementState(tx.ontology.materializations, session, first)
      await tx.ontology.materializations.finalize({
        session,
        finalization: replacementFinalization(first, firstHeader),
      })
    })

    const second = await prepareEmptyCandidate(storage, {
      projectionId: "devices",
      projectionKind: "object",
      runId: "second-run",
      materializationId: "second-candidate",
      versionId: "v2",
      datasetCreatedAt: "2026-01-02T00:00:00.000Z",
      candidateCreatedAt: "2026-01-02T00:00:00.000Z",
      readyAt: "2026-01-02T01:00:00.000Z",
    })
    const secondHeader = replacementHeader(
      second,
      "before-active-update-commit",
      "2026-01-02T12:00:00.000Z",
      { materializationId: first.materializationId, commitId: firstHeader.commit.id }
    )
    await expect(
      storage.transaction(async (tx) => {
        if (!tx.ontology) throw new Error("missing ontology")
        const session = await tx.ontology.materializations.begin(secondHeader)
        await drainReplacementState(tx.ontology.materializations, session, second)
        await tx.ontology.materializations.finalize({
          session,
          finalization: replacementFinalization(second, secondHeader),
        })
      })
    ).rejects.toThrow("cannot precede the active materialization update")
  })

  test("fences source dataset watermarks at provider activation", async () => {
    const storage = new InMemoryStorage()
    const active = await prepareEmptyCandidate(storage, {
      projectionId: "devices",
      projectionKind: "object",
      runId: "watermark-active-run",
      materializationId: "watermark-active-candidate",
      versionId: "v2",
      datasetCreatedAt: "2026-01-02T00:00:00.000Z",
      candidateCreatedAt: "2026-01-03T00:00:00.000Z",
      readyAt: "2026-01-03T01:00:00.000Z",
    })
    const activeHeader = replacementHeader(
      active,
      "watermark-active-commit",
      "2026-01-04T00:00:00.000Z"
    )
    await storage.transaction(async (tx) => {
      if (!tx.ontology) throw new Error("missing ontology")
      const session = await tx.ontology.materializations.begin(activeHeader)
      await drainReplacementState(tx.ontology.materializations, session, active)
      await tx.ontology.materializations.finalize({
        session,
        finalization: replacementFinalization(active, activeHeader),
      })
    })

    const cases = [
      {
        name: "dataset mismatch",
        datasetId: "other-dataset",
        versionId: "v3",
        datasetCreatedAt: "2026-01-03T00:00:00.000Z",
        message: "does not match the active source dataset",
      },
      {
        name: "regression",
        datasetId: "devices",
        versionId: "v1",
        datasetCreatedAt: "2026-01-01T00:00:00.000Z",
        message: "older than the active watermark",
      },
      {
        name: "ambiguous equal timestamp",
        datasetId: "devices",
        versionId: "v3",
        datasetCreatedAt: "2026-01-02T00:00:00.000Z",
        message: "watermark is ambiguous",
      },
    ] as const

    for (const [index, testCase] of cases.entries()) {
      const candidate = await prepareEmptyCandidate(storage, {
        projectionId: "devices",
        datasetId: testCase.datasetId,
        projectionKind: "object",
        runId: `watermark-${index}-run`,
        materializationId: `watermark-${index}-candidate`,
        versionId: testCase.versionId,
        datasetCreatedAt: testCase.datasetCreatedAt,
        candidateCreatedAt: "2026-01-05T00:00:00.000Z",
        readyAt: "2026-01-05T01:00:00.000Z",
      })
      const header = replacementHeader(
        candidate,
        `watermark-${index}-commit`,
        "2026-01-06T00:00:00.000Z",
        { materializationId: active.materializationId, commitId: activeHeader.commit.id }
      )
      await expect(
        storage.transaction(async (tx) => {
          if (!tx.ontology) throw new Error("missing ontology")
          const session = await tx.ontology.materializations.begin(header)
          await drainReplacementState(tx.ontology.materializations, session, candidate)
          await tx.ontology.materializations.finalize({
            session,
            finalization: replacementFinalization(candidate, header),
          })
        }),
        testCase.name
      ).rejects.toThrow(testCase.message)
    }
  })
})
