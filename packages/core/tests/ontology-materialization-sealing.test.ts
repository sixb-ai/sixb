import { describe, expect, test } from "bun:test"
import { InMemoryStorage } from "../src"
import { linkRefSortKey, linkScopeSortKey } from "../src/materialization/refs"
import type {
  MaterializationCardinalityOccupantWorkRecord,
  MaterializationPlanFinalization,
  MaterializationPlanHeader,
  MaterializationPlanWorkRecord,
  MaterializationSession,
  MaterializationStatePage,
  ProjectionRunClaim,
  Storage,
} from "../src/storage"
import { getInMemoryOntologyStorageTestingAdapter } from "../src/storage/ontology/in-memory/testing"
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
  readonly executionId: string
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
    executionId: run.run.executionId,
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
      executionId: candidate.executionId,
      origin: {
        kind: "projection",
        projectionId: candidate.source.projectionId,
        projectionRunId: candidate.execution.projectionRunId,
        datasetId: candidate.datasetVersion.datasetId,
        datasetVersionId: candidate.datasetVersion.versionId,
      },
      executor: {
        type: "primitive",
        kind: "projection",
        id: candidate.source.projectionId,
        runId: candidate.execution.projectionRunId,
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

/** Plans an empty candidate inside `tx`, so a failed commit forgets the plan with it. */
async function beginPlanned(
  tx: Pick<Storage, "executions" | "ontology">,
  header: MaterializationPlanHeader,
  candidate: CandidateFixture
): Promise<MaterializationSession> {
  if (!tx.ontology) throw new Error("missing ontology")
  const plan = {
    projectId,
    source: candidate.source,
    materializationId: candidate.materializationId,
    execution: candidate.execution,
  }
  await tx.ontology.replacementPlans.open({ ...plan, commit: header.commit })
  for (const entityKind of candidate.projectionKind === "object"
    ? (["object", "link"] as const)
    : (["link"] as const)) {
    for await (const _page of tx.ontology.replacementPlans.streamState({
      ...plan,
      entityKind,
      pageRows: 1,
    })) {
      // Empty candidates have no identity to plan.
    }
  }
  const status = await tx.ontology.replacementPlans.refresh(plan)
  if (!status.fresh) throw new Error("An empty plan has nothing to plan again.")
  return beginMaterialization(tx, {
    ...header,
    plan: { source: candidate.source, materializationId: candidate.materializationId },
  })
}

function emptyEditHeader(commitId: string): MaterializationPlanHeader {
  return {
    commit: {
      projectId,
      id: commitId,
      idempotencyKey: `runtime:${commitId}`,
      requestHash: commitId,
      executionId: `execution:${commitId}`,
      origin: { kind: "runtime", requestId: commitId },
      executor: { type: "request", requestId: commitId },
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

async function beginMaterialization(
  storage: Pick<Storage, "executions" | "ontology">,
  header: MaterializationPlanHeader
): Promise<MaterializationSession> {
  if (!storage.ontology) throw new Error("missing ontology")
  const execution = await storage.executions.getById({
    projectId: header.commit.projectId,
    id: header.commit.executionId,
  })
  if (!execution) {
    await storage.executions.create({
      id: header.commit.executionId,
      projectId: header.commit.projectId,
      executor: { type: "request", requestId: `request:${header.commit.id}` },
      source: { type: "http", requestId: `request:${header.commit.id}` },
      correlationId: `correlation:${header.commit.id}`,
      authorizationRef: { type: "disabled" },
    })
  }
  return storage.ontology.materializations.begin(header)
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
        beginMaterialization(storage, emptyEditHeader("stale-transaction-context"))
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
        const session = await beginMaterialization(tx, emptyEditHeader("leaked-stream"))
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

  test("begins a plan-bound session only with the commit its plan carries", async () => {
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
        await beginPlanned(tx, header, candidate)
        await beginMaterialization(tx, {
          ...replacementHeader(candidate, "empty-object-commit", "2026-01-03T00:00:01.000Z"),
          plan: { source: candidate.source, materializationId: candidate.materializationId },
        })
      })
    ).rejects.toThrow("must begin with the commit its plan carries")
  })

  test("plans only links for an empty link projection", async () => {
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
      const session = await beginPlanned(tx, header, candidate)
      await tx.ontology.materializations.apply({ session })
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

  test("keeps a plan-bound session to its plan and requires telemetry classification coverage", async () => {
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
        const session = await beginPlanned(tx, header, candidate)
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
      })
    ).rejects.toThrow("applies its plan and stages no work")

    const telemetryHeader: MaterializationPlanHeader = {
      commit: {
        projectId,
        id: "telemetry-classification",
        idempotencyKey: "runtime:telemetry-classification",
        requestHash: "telemetry-classification",
        executionId: "execution:telemetry-classification",
        origin: {
          kind: "telemetry",
          source: { kind: "runtime", requestId: "telemetry-classification" },
        },
        executor: { type: "request", requestId: "telemetry-classification" },
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
        const session = await beginMaterialization(tx, telemetryHeader)
        await tx.ontology.materializations.apply({ session })
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

  test("finalizes only once the staged plan applies, and stages nothing after", async () => {
    const storage = new InMemoryStorage()
    const header = emptyEditHeader("unapplied-plan")
    await expect(
      storage.transaction(async (tx) => {
        if (!tx.ontology) throw new Error("missing ontology")
        const session = await beginMaterialization(tx, header)
        await tx.ontology.materializations.stageWork({
          session,
          records: [objectUpsertWork(header, "one", "61")],
        })
        await tx.ontology.materializations.finalize({
          session,
          finalization: emptyEditFinalization(header),
        })
      })
    ).rejects.toThrow("must apply before it finalizes")

    await expect(
      storage.transaction(async (tx) => {
        if (!tx.ontology) throw new Error("missing ontology")
        const session = await beginMaterialization(tx, header)
        await tx.ontology.materializations.apply({ session })
        await tx.ontology.materializations.stageWork({
          session,
          records: [objectUpsertWork(header, "one", "61")],
        })
      })
    ).rejects.toThrow("once vector changes stream or the plan applies")
  })

  test("applies the staged plan once, in phase order", async () => {
    const storage = new InMemoryStorage()
    const header = emptyEditHeader("ordered-plan")
    const writes: string[] = []
    getInMemoryOntologyStorageTestingAdapter(storage.ontology).setTestHooks({
      beforeWrite(boundary) {
        writes.push(boundary)
      },
    })
    const link = {
      source: { objectTypeId: "Device", primaryId: "one" },
      linkId: "parent",
      target: { objectTypeId: "Device", primaryId: "two" },
    }
    await storage.transaction(async (tx) => {
      if (!tx.ontology) throw new Error("missing ontology")
      const session = await beginMaterialization(tx, header)
      await tx.ontology.materializations.stageWork({
        session,
        records: [
          {
            kind: "plan",
            recordKey: "plan:link-upsert:61",
            applyPhase: 5,
            sortKey: "61",
            item: {
              kind: "link-upsert",
              value: {
                row: {
                  ref: link,
                  createdAt: header.commit.committedAt,
                  updatedAt: header.commit.committedAt,
                  lastCommitId: header.commit.id,
                },
                expected: { ref: link, exists: false },
              },
            },
          },
          objectUpsertWork(header, "two", "62"),
          objectUpsertWork(header, "one", "61"),
        ],
      })
      await tx.ontology.materializations.apply({ session })
      await expect(tx.ontology.materializations.apply({ session })).rejects.toThrow(
        "applies once per session"
      )
      await tx.ontology.materializations.finalize({
        session,
        finalization: emptyEditFinalization(header),
      })
    })
    expect(writes.filter((boundary) => boundary.startsWith("effective."))).toEqual([
      "effective.object.upsert",
      "effective.object.upsert",
      "effective.link.upsert",
    ])
  })

  test("rejects a cardinality-one scope with two occupants before applying", async () => {
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
        const session = await beginMaterialization(tx, header)
        await tx.ontology.materializations.stageWork({ session, records })
        await tx.ontology.materializations.apply({ session })
      })
    ).rejects.toThrow("Link scope 'Device.parent' has cardinality one.")
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
        const session = await beginMaterialization(tx, header)
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
        // Apply accepts the dishonest record; finalization must inspect the durable scope.
        await tx.ontology.materializations.apply({ session })
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
        const session = await beginPlanned(tx, header, opened)
        await tx.ontology.materializations.apply({ session })
        await tx.ontology.materializations.finalize({
          session,
          finalization: replacementFinalization(activated, header),
        })
      })
    ).rejects.toThrow("does not match the replacement plan the session applies")
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
        const session = await beginPlanned(tx, tooEarlyHeader, first)
        await tx.ontology.materializations.apply({ session })
        await tx.ontology.materializations.finalize({
          session,
          finalization: replacementFinalization(first, tooEarlyHeader),
        })
      })
    ).rejects.toThrow("cannot precede candidate readiness")

    const firstHeader = replacementHeader(first, "first-commit", "2026-01-03T00:00:00.000Z")
    await storage.transaction(async (tx) => {
      if (!tx.ontology) throw new Error("missing ontology")
      const session = await beginPlanned(tx, firstHeader, first)
      await tx.ontology.materializations.apply({ session })
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
        const session = await beginPlanned(tx, secondHeader, second)
        await tx.ontology.materializations.apply({ session })
        await tx.ontology.materializations.finalize({
          session,
          finalization: replacementFinalization(second, secondHeader),
        })
      })
    ).rejects.toThrow("cannot precede the active materialization update")
  })

  test("fences source dataset watermarks at provider activation and starts one per dataset", async () => {
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
      const session = await beginPlanned(tx, activeHeader, active)
      await tx.ontology.materializations.apply({ session })
      await tx.ontology.materializations.finalize({
        session,
        finalization: replacementFinalization(active, activeHeader),
      })
    })

    const cases = [
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
          const session = await beginPlanned(tx, header, candidate)
          await tx.ontology.materializations.apply({ session })
          await tx.ontology.materializations.finalize({
            session,
            finalization: replacementFinalization(candidate, header),
          })
        }),
        testCase.name
      ).rejects.toThrow(testCase.message)
    }

    // Red proof: restore the "dataset-mismatch" conflict in comparePinnedDatasetWatermarks; this
    // rebind, with a version older than the active one, is rejected as a mismatch.
    const rebound = await prepareEmptyCandidate(storage, {
      projectionId: "devices",
      datasetId: "devices.v2",
      projectionKind: "object",
      runId: "watermark-rebound-run",
      materializationId: "watermark-rebound-candidate",
      versionId: "v1",
      datasetCreatedAt: "2026-01-01T00:00:00.000Z",
      candidateCreatedAt: "2026-01-05T00:00:00.000Z",
      readyAt: "2026-01-05T01:00:00.000Z",
    })
    const reboundHeader = replacementHeader(
      rebound,
      "watermark-rebound-commit",
      "2026-01-06T00:00:00.000Z",
      { materializationId: active.materializationId, commitId: activeHeader.commit.id }
    )
    await storage.transaction(async (tx) => {
      if (!tx.ontology) throw new Error("missing ontology")
      const session = await beginPlanned(tx, reboundHeader, rebound)
      await tx.ontology.materializations.apply({ session })
      await tx.ontology.materializations.finalize({
        session,
        finalization: replacementFinalization(rebound, reboundHeader),
      })
    })
    expect(
      await storage.ontology.sources.getActive({ projectId, source: rebound.source })
    ).toMatchObject({
      materializationId: rebound.materializationId,
      datasetVersion: { datasetId: "devices.v2", versionId: "v1" },
    })
  })
})
