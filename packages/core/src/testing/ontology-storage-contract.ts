import { describe, expect, test } from "bun:test"
import type {
  ProjectionExecution,
  ProjectionMaterializationIdentity,
} from "../materialization/model"
import type {
  MaterializationPlanFinalization,
  MaterializationPlanHeader,
  OntologySourceRecord,
} from "../storage/ontology"
import {
  isProjectionMaterializationRunStorage,
  type ProjectionMaterializationRunStorage,
} from "../storage/projection-runs"
import {
  commitEmptyEdit,
  commitExactObject,
  contractEditHeader,
  type OntologyContractStorage,
} from "./ontology-contract-fixture"

export interface OntologyStorageContractStorage extends OntologyContractStorage {
  readonly projectionRuns: ProjectionMaterializationRunStorage
}

export interface OntologyStorageContractSuiteOptions<
  TStorage extends OntologyStorageContractStorage = OntologyStorageContractStorage,
> {
  /** Factory that returns a fresh, fully transaction-capable storage facade for each test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  /** Optional provider setup invoked after the storage facade is created. */
  readonly setup?: (storage: TStorage) => void | Promise<void>
  /** Optional provider cleanup invoked after every test, including failed tests. */
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const replacementIdentity = (
  versionId: string,
  projectionId = "contract.devices"
): ProjectionMaterializationIdentity => ({
  projectionId,
  projectionKind: "object",
  protocol: "replacement",
  datasetVersion: {
    datasetId: "contract.devices",
    versionId,
    createdAt: `2026-01-${versionId.padStart(2, "0")}T00:00:00.000Z`,
  },
  ontologyRevision: "ontology-contract-revision",
  projectionRevision: "projection-contract-revision",
  ownershipHash: "ownership-contract-hash",
})

const emptyProjectionCounts = {
  objectsCreated: 0,
  objectsUpdated: 0,
  objectsDeleted: 0,
  objectsUnchanged: 0,
  linksCreated: 0,
  linksUpdated: 0,
  linksDeleted: 0,
  linksUnchanged: 0,
} as const

interface ReadyCandidate {
  readonly identity: ProjectionMaterializationIdentity
  readonly execution: ProjectionExecution
  readonly materializationId: string
  readonly source: { readonly projectionId: string }
}

/**
 * Runs provider-level ontology persistence contracts without asking the provider
 * to interpret ontology definitions, edits, or projection rows. Exact plans are
 * supplied directly and the suite checks durable lifecycle, CAS, outbox, and
 * cross-facade transaction behavior.
 */
export function runOntologyStorageContractSuite<TStorage extends OntologyStorageContractStorage>(
  label: string,
  options: OntologyStorageContractSuiteOptions<TStorage>
): void {
  const withStorage = async (body: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await options.setup?.(storage)
      await body(storage)
    } finally {
      await options.cleanup?.(storage)
    }
  }

  describe(label, () => {
    test("stores one authoritative commit and rejects duplicate commit identities", async () => {
      await withStorage(async (storage) => {
        await commitEmptyEdit(storage, "commit-one")
        const stored = await storage.ontology.commits.getById({
          projectId: "contract-project",
          id: "commit-one",
        })
        expect(stored).toMatchObject({
          id: "commit-one",
          idempotencyKey: "runtime:commit-one",
          requestHash: "hash:commit-one",
          result: { commitId: "commit-one" },
        })
        expect(
          await storage.ontology.commits.getByIdempotencyKey({
            projectId: "contract-project",
            idempotencyKey: "runtime:commit-one",
          })
        ).toEqual(stored)

        await expect(commitEmptyEdit(storage, "commit-one")).rejects.toMatchObject({
          kind: "idempotency",
        })
        const divergent = structuredClone(contractEditHeader("different-id"))
        ;(divergent.commit as { idempotencyKey: string }).idempotencyKey = "runtime:commit-one"
        ;(divergent.commit as { requestHash: string }).requestHash = "different-hash"
        await expect(
          storage.transaction(async (tx) => {
            await tx.ontology.materializations.begin(divergent)
          })
        ).rejects.toMatchObject({ kind: "idempotency" })

        const list = await storage.ontology.commits.list({
          projectId: "contract-project",
          limit: 1,
          offset: 0,
        })
        expect(list).toMatchObject({ total: 1, hasMore: false })
        expect(list.commits.map((commit) => commit.id)).toEqual(["commit-one"])
      })
    })

    test("keeps sessions transaction-scoped and invalidates unfinished handles", async () => {
      await withStorage(async (storage) => {
        const header = contractEditHeader("session-contract")
        await expect(storage.ontology.materializations.begin(header)).rejects.toThrow(
          "active storage transaction"
        )

        let unfinished: Awaited<ReturnType<typeof storage.ontology.materializations.begin>> | null =
          null
        await storage.transaction(async (tx) => {
          unfinished = await tx.ontology.materializations.begin(header)
        })
        await expect(
          storage.transaction(async (tx) => {
            if (!unfinished) throw new Error("missing contract session")
            await tx.ontology.materializations.stageWork({ session: unfinished, records: [] })
          })
        ).rejects.toThrow("inactive")
      })
    })

    test("stages insert-only source rows, seals counts, and fences stale execution tokens", async () => {
      await withStorage(async (storage) => {
        const identity = replacementIdentity("01")
        const claimed = await storage.projectionRuns.startOrReclaimMaterialization({
          id: "staging-run",
          projectId: "contract-project",
          identity,
          objectTypeId: "ContractDevice",
        })
        const execution = {
          projectionRunId: claimed.id,
          executionToken: claimed.executionToken,
        }
        const source = { projectionId: identity.projectionId }
        await expect(
          storage.ontology.sources.beginMaterialization({
            projectId: "contract-project",
            source,
            materializationId: "mismatched-candidate",
            execution,
            projectionKind: "link",
            protocol: "replacement",
            datasetVersion: identity.datasetVersion,
            projectionRevision: identity.projectionRevision,
            ownershipHash: identity.ownershipHash,
            ontologyRevision: identity.ontologyRevision,
            createdAt: "2026-01-01T00:00:00.000Z",
          })
        ).rejects.toThrow("identity")
        await storage.ontology.sources.beginMaterialization({
          projectId: "contract-project",
          source,
          materializationId: "staging-candidate",
          execution,
          projectionKind: "object",
          protocol: "replacement",
          datasetVersion: identity.datasetVersion,
          projectionRevision: identity.projectionRevision,
          ownershipHash: identity.ownershipHash,
          ontologyRevision: identity.ontologyRevision,
          createdAt: "2026-01-01T00:00:00.000Z",
        })
        expect(
          await storage.ontology.sources.getActive({ projectId: "contract-project", source })
        ).toBeNull()

        const row = {
          root: {
            kind: "object" as const,
            ref: { objectTypeId: "ContractDevice", primaryId: "one" },
          },
          assertion: {
            kind: "object" as const,
            ref: { objectTypeId: "ContractDevice", primaryId: "one" },
            properties: { name: "one" },
          },
          stagingOrdinal: 0,
        }
        expect(
          await storage.ontology.sources.stageRows({
            projectId: "contract-project",
            source,
            materializationId: "staging-candidate",
            execution,
            rows: [row],
          })
        ).toEqual({ inserted: 1, unchanged: 0 })
        expect(
          await storage.ontology.sources.stageRows({
            projectId: "contract-project",
            source,
            materializationId: "staging-candidate",
            execution,
            rows: [row],
          })
        ).toEqual({ inserted: 0, unchanged: 1 })
        await expect(
          storage.ontology.sources.stageRows({
            projectId: "contract-project",
            source,
            materializationId: "staging-candidate",
            execution,
            rows: [
              {
                ...row,
                assertion: { ...row.assertion, properties: { name: "different" } },
              },
            ],
          })
        ).rejects.toThrow()

        const ready = await storage.ontology.sources.markReady({
          projectId: "contract-project",
          source,
          materializationId: "staging-candidate",
          execution,
          rootCount: 1,
          assertionCount: 1,
          readyAt: "2026-01-01T00:01:00.000Z",
        })
        expect(ready).toMatchObject({ status: "ready", rootCount: 1, assertionCount: 1 })

        const reclaimed = await storage.projectionRuns.startOrReclaimMaterialization({
          id: claimed.id,
          projectId: claimed.projectId,
          identity,
          objectTypeId: "ContractDevice",
        })
        await expect(
          storage.ontology.sources.stageRows({
            projectId: "contract-project",
            source,
            materializationId: "staging-candidate",
            execution,
            rows: [],
          })
        ).rejects.toMatchObject({ kind: "execution-lost" })
        await expect(
          storage.ontology.sources.markReady({
            projectId: "contract-project",
            source,
            materializationId: "staging-candidate",
            execution,
            rootCount: 1,
            assertionCount: 1,
            readyAt: "2026-01-01T00:03:00.000Z",
          })
        ).rejects.toMatchObject({ kind: "execution-lost" })
        await expect(
          storage.ontology.sources.abandon({
            kind: "candidate",
            projectId: "contract-project",
            source,
            materializationId: "staging-candidate",
            execution,
            abandonedAt: "2026-01-01T00:03:00.000Z",
          })
        ).rejects.toMatchObject({ kind: "execution-lost" })
        const abandoned = await storage.ontology.sources.abandon({
          kind: "reclaim",
          projectId: "contract-project",
          source,
          execution: {
            projectionRunId: reclaimed.id,
            executionToken: reclaimed.executionToken,
          },
          abandonedAt: "2026-01-01T00:02:00.000Z",
        })
        expect(abandoned).toMatchObject({ status: "abandoned", executionToken: null })

        expect(
          await storage.ontology.sources.cleanupTerminal({
            projectId: "contract-project",
            terminalBefore: "2026-02-01T00:00:00.000Z",
            limit: 1,
          })
        ).toEqual({ rowsDeleted: 1, materializationsDeleted: 0 })
        expect(
          await storage.ontology.sources.cleanupTerminal({
            projectId: "contract-project",
            terminalBefore: "2026-02-01T00:00:00.000Z",
            limit: 1,
          })
        ).toEqual({ rowsDeleted: 0, materializationsDeleted: 1 })
      })
    })

    test("atomically activates explicit empty candidates and rejects competing stale heads", async () => {
      await withStorage(async (storage) => {
        const first = await createReadyEmptyCandidate(storage, "run-one", "candidate-one", "01")
        await activateEmptyCandidate(
          storage,
          first,
          null,
          "commit-source-one",
          "2026-01-03T00:00:00.000Z"
        )
        const activeOne = await storage.ontology.sources.getActive({
          projectId: "contract-project",
          source: first.source,
        })
        expect(activeOne).toMatchObject({
          materializationId: first.materializationId,
          status: "active",
          rootCount: 0,
          assertionCount: 0,
          executionToken: null,
        })
        expect(
          await storage.ontology.commits.getByOrigin({
            projectId: "contract-project",
            origin: { kind: "projection", projectionRunId: first.execution.projectionRunId },
          })
        ).toMatchObject({ id: "commit-source-one" })
        await expect(
          activateEmptyCandidate(
            storage,
            first,
            activeOne,
            "duplicate-projection-origin",
            "2026-01-03T01:00:00.000Z"
          )
        ).rejects.toMatchObject({ kind: "run-correlation" })

        const left = await createReadyEmptyCandidate(storage, "run-left", "candidate-left", "02")
        const right = await createReadyEmptyCandidate(storage, "run-right", "candidate-right", "03")
        await activateEmptyCandidate(
          storage,
          left,
          activeOne!,
          "commit-source-left",
          "2026-01-04T00:00:00.000Z"
        )
        await expect(
          activateEmptyCandidate(
            storage,
            right,
            activeOne!,
            "commit-source-right",
            "2026-01-05T00:00:00.000Z"
          )
        ).rejects.toMatchObject({ kind: "projection-fence" })
        const currentActive = await storage.ontology.sources.getActive({
          projectId: "contract-project",
          source: first.source,
        })
        expect(currentActive).toMatchObject({ materializationId: left.materializationId })

        const stale = await createReadyEmptyCandidate(
          storage,
          "run-stale-activation",
          "candidate-stale-activation",
          "04"
        )
        const reclaimed = await storage.projectionRuns.startOrReclaimMaterialization({
          id: stale.execution.projectionRunId,
          projectId: "contract-project",
          identity: stale.identity,
          objectTypeId: "ContractDevice",
        })
        await expect(
          activateEmptyCandidate(
            storage,
            stale,
            currentActive,
            "commit-stale-activation",
            "2026-01-06T00:00:00.000Z"
          )
        ).rejects.toThrow("execution token is stale")
        await storage.ontology.sources.abandon({
          kind: "reclaim",
          projectId: "contract-project",
          source: stale.source,
          execution: {
            projectionRunId: reclaimed.id,
            executionToken: reclaimed.executionToken,
          },
          abandonedAt: "2026-01-06T00:01:00.000Z",
        })

        const cleanup = await storage.ontology.sources.cleanupTerminal({
          projectId: "contract-project",
          terminalBefore: "2026-02-01T00:00:00.000Z",
          limit: 10,
        })
        expect(cleanup.materializationsDeleted).toBeGreaterThanOrEqual(1)
        expect(
          await storage.ontology.sources.getActive({
            projectId: "contract-project",
            source: first.source,
          })
        ).toMatchObject({ materializationId: left.materializationId })
        expect(
          await storage.ontology.sources.abandon({
            kind: "candidate",
            projectId: "contract-project",
            source: right.source,
            materializationId: right.materializationId,
            execution: right.execution,
            abandonedAt: "2026-02-02T00:00:00.000Z",
          })
        ).toMatchObject({ status: "abandoned" })
      })
    })

    test("rolls back exact rows, commits, and outbox writes through one transaction facade", async () => {
      await withStorage(async (storage) => {
        await expect(
          commitExactObject(storage, "rolled-back", { throwAfterFinalize: true })
        ).rejects.toThrow("contract rollback")
        expect(
          await storage.objects.getByPrimaryId({
            projectId: "contract-project",
            objectTypeId: "ContractDevice",
            primaryId: "rolled-back",
          })
        ).toBeNull()
        expect(
          await storage.ontology.commits.getById({
            projectId: "contract-project",
            id: "rolled-back",
          })
        ).toBeNull()
        expect(
          await storage.ontology.outbox.claim({
            projectId: "contract-project",
            now: "2027-01-01T00:00:00.000Z",
            limit: 10,
            leaseId: "rollback-check",
            leaseExpiresAt: "2027-01-01T01:00:00.000Z",
          })
        ).toEqual([])

        await commitExactObject(storage, "committed")
        expect(
          await storage.objects.getByPrimaryId({
            projectId: "contract-project",
            objectTypeId: "ContractDevice",
            primaryId: "committed",
          })
        ).toMatchObject({ properties: { name: "committed" }, lastCommitId: "committed" })

        await expect(
          commitExactObject(storage, "stale-object-cas", { primaryId: "committed" })
        ).rejects.toThrow("to be absent")
        expect(
          await storage.ontology.commits.getById({
            projectId: "contract-project",
            id: "stale-object-cas",
          })
        ).toBeNull()
        expect(
          await storage.objects.getByPrimaryId({
            projectId: "contract-project",
            objectTypeId: "ContractDevice",
            primaryId: "committed",
          })
        ).toMatchObject({ properties: { name: "committed" }, lastCommitId: "committed" })
      })
    })

    test("leases outbox rows exclusively, reclaims expiry, fences stale workers, and purges", async () => {
      await withStorage(async (storage) => {
        const outboxB = await commitExactObject(storage, "outbox-b")
        const outboxA = await commitExactObject(storage, "outbox-a")
        await expect(
          storage.ontology.outbox.claim({
            projectId: "contract-project",
            now: "2026-01-02T19:00:00-05:00",
            limit: 1,
            leaseId: "noncanonical-lease",
            leaseExpiresAt: "2026-01-03T01:00:00.000Z",
          })
        ).rejects.toThrow("canonical UTC")
        const first = await storage.ontology.outbox.claim({
          projectId: "contract-project",
          now: "2026-01-03T00:00:00.000Z",
          limit: 1,
          leaseId: "lease-one",
          leaseExpiresAt: "2026-01-03T01:00:00.000Z",
        })
        expect(first).toHaveLength(1)
        expect(first[0]).toMatchObject({ attempts: 1, leaseId: "lease-one" })
        expect(first[0].envelope.id).toBe([outboxA.eventId, outboxB.eventId].sort()[0])
        const concurrent = await storage.ontology.outbox.claim({
          projectId: "contract-project",
          now: "2026-01-03T00:30:00.000Z",
          limit: 10,
          leaseId: "lease-concurrent",
          leaseExpiresAt: "2026-01-03T01:30:00.000Z",
        })
        expect(concurrent).toHaveLength(1)
        expect(concurrent[0].envelope.id).not.toBe(first[0].envelope.id)

        const reclaimed = await storage.ontology.outbox.claim({
          projectId: "contract-project",
          now: "2026-01-03T02:00:00.000Z",
          limit: 1,
          leaseId: "lease-two",
          leaseExpiresAt: "2026-01-03T03:00:00.000Z",
        })
        expect(reclaimed[0].envelope.id).toBe(first[0].envelope.id)
        await expect(
          storage.ontology.outbox.markPublished({
            projectId: "contract-project",
            ids: [first[0].envelope.id],
            leaseId: "lease-one",
            publishedAt: "2026-01-03T02:10:00.000Z",
          })
        ).rejects.toThrow("lease does not match")
        await storage.ontology.outbox.reschedule({
          projectId: "contract-project",
          ids: [reclaimed[0].envelope.id],
          leaseId: "lease-two",
          availableAt: "2026-01-04T00:00:00.000Z",
          error: "broker unavailable",
        })
        const retried = await storage.ontology.outbox.claim({
          projectId: "contract-project",
          now: "2026-01-04T00:00:00.000Z",
          limit: 1,
          leaseId: "lease-three",
          leaseExpiresAt: "2026-01-04T01:00:00.000Z",
        })
        expect(retried[0]).toMatchObject({ attempts: 3, lastError: "broker unavailable" })
        await storage.ontology.outbox.markPublished({
          projectId: "contract-project",
          ids: [retried[0].envelope.id],
          leaseId: "lease-three",
          publishedAt: "2026-01-04T00:30:00.000Z",
        })
        expect(
          await storage.ontology.outbox.purgePublished({
            projectId: "contract-project",
            publishedBefore: "2026-01-05T00:00:00.000Z",
            limit: 1,
          })
        ).toBe(1)
      })
    })

    test("keeps batch outbox settlement atomic when callers catch a stale lease", async () => {
      await withStorage(async (storage) => {
        await commitExactObject(storage, "lease-atomic-a")
        await commitExactObject(storage, "lease-atomic-b")
        const claimed = await storage.ontology.outbox.claim({
          projectId: "contract-project",
          now: "2026-01-03T00:00:00.000Z",
          limit: 10,
          leaseId: "lease-atomic-old",
          leaseExpiresAt: "2026-01-03T01:00:00.000Z",
        })
        expect(claimed).toHaveLength(2)
        const [reclaimed] = await storage.ontology.outbox.claim({
          projectId: "contract-project",
          now: "2026-01-03T02:00:00.000Z",
          limit: 1,
          leaseId: "lease-atomic-new",
          leaseExpiresAt: "2026-01-03T03:00:00.000Z",
        })
        const untouched = claimed.find((row) => row.envelope.id !== reclaimed!.envelope.id)!

        let conflict: unknown
        await storage.transaction(async (tx) => {
          try {
            await tx.ontology.outbox.markPublished({
              projectId: "contract-project",
              ids: claimed.map((row) => row.envelope.id),
              leaseId: "lease-atomic-old",
              publishedAt: "2026-01-03T02:10:00.000Z",
            })
          } catch (error) {
            conflict = error
          }
        })
        expect(conflict).toMatchObject({ kind: "outbox-lease" })

        await storage.ontology.outbox.markPublished({
          projectId: "contract-project",
          ids: [untouched.envelope.id],
          leaseId: "lease-atomic-old",
          publishedAt: "2026-01-03T02:20:00.000Z",
        })
      })
    })

    test("rolls back a telemetry checkpoint with its authoritative ontology commit", async () => {
      await withStorage(async (storage) => {
        const identity: ProjectionMaterializationIdentity = {
          projectionId: "contract.telemetry",
          projectionKind: "telemetry",
          protocol: "telemetry",
          datasetVersion: {
            datasetId: "contract.readings",
            versionId: "telemetry-version",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          ontologyRevision: "ontology-contract-revision",
          projectionRevision: "telemetry-contract-revision",
          ownershipHash: "telemetry-contract-ownership",
        }
        const run = await storage.projectionRuns.startOrReclaimMaterialization({
          id: "telemetry-run",
          projectId: "contract-project",
          identity,
          objectTypeId: "ContractDevice",
          fixedBatchSize: 2,
        })
        const execute = async (throwAfter: boolean) => {
          await storage.transaction(async (tx) => {
            if (!isProjectionMaterializationRunStorage(tx.projectionRuns)) {
              throw new Error("Contract transaction omitted required storage facades.")
            }
            const header = telemetryHeader(identity, run.id)
            const session = await tx.ontology.materializations.begin(header)
            await tx.ontology.materializations.finalize({
              session,
              finalization: {
                sourceActivations: [],
                result: {
                  kind: "telemetry",
                  commitId: header.commit.id,
                  created: true,
                  eventCount: 0,
                  pointsCreated: 0,
                  pointsUpdated: 0,
                  pointsUnchanged: 0,
                  latestObjectsChanged: 0,
                },
              },
            })
            await tx.projectionRuns.advanceTelemetryCheckpoint({
              id: run.id,
              projectId: run.projectId,
              identity,
              executionToken: run.executionToken,
              batchOrdinal: 0,
              batchRowCount: 2,
              inputExhausted: true,
            })
            if (throwAfter) throw new Error("telemetry rollback")
          })
        }

        await expect(execute(true)).rejects.toThrow("telemetry rollback")
        expect(
          await storage.ontology.commits.getByOrigin({
            projectId: "contract-project",
            origin: { kind: "telemetry", projectionRunId: run.id, batchOrdinal: 0 },
          })
        ).toBeNull()
        expect(
          await storage.projectionRuns.getById({ projectId: run.projectId, id: run.id })
        ).toMatchObject({
          telemetryCheckpoint: { nextBatchOrdinal: 0, nextRowOffset: 0, inputExhausted: false },
        })

        await execute(false)
        expect(
          await storage.ontology.commits.getByOrigin({
            projectId: "contract-project",
            origin: { kind: "telemetry", projectionRunId: run.id, batchOrdinal: 0 },
          })
        ).toMatchObject({ id: "telemetry-commit" })
        expect(
          await storage.projectionRuns.getById({ projectId: run.projectId, id: run.id })
        ).toMatchObject({
          telemetryCheckpoint: { nextBatchOrdinal: 1, nextRowOffset: 2, inputExhausted: true },
        })
      })
    })
  })
}

async function createReadyEmptyCandidate(
  storage: OntologyStorageContractStorage,
  runId: string,
  materializationId: string,
  versionId: string
): Promise<ReadyCandidate> {
  const identity = replacementIdentity(versionId)
  const run = await storage.projectionRuns.startOrReclaimMaterialization({
    id: runId,
    projectId: "contract-project",
    identity,
    objectTypeId: "ContractDevice",
  })
  const execution = { projectionRunId: run.id, executionToken: run.executionToken }
  const source = { projectionId: identity.projectionId }
  await storage.ontology.sources.beginMaterialization({
    projectId: run.projectId,
    source,
    materializationId,
    execution,
    projectionKind: "object",
    protocol: "replacement",
    datasetVersion: identity.datasetVersion,
    projectionRevision: identity.projectionRevision,
    ownershipHash: identity.ownershipHash,
    ontologyRevision: identity.ontologyRevision,
    createdAt: identity.datasetVersion.createdAt,
  })
  await storage.ontology.sources.markReady({
    projectId: run.projectId,
    source,
    materializationId,
    execution,
    rootCount: 0,
    assertionCount: 0,
    readyAt: new Date(Date.parse(identity.datasetVersion.createdAt) + 1_000).toISOString(),
  })
  return { identity, execution, materializationId, source }
}

async function activateEmptyCandidate(
  storage: OntologyStorageContractStorage,
  candidate: ReadyCandidate,
  expectedActive: OntologySourceRecord | null,
  commitId: string,
  committedAt: string
): Promise<void> {
  const expected = {
    source: candidate.source,
    activeMaterializationId: expectedActive?.materializationId ?? null,
    lastCommitId: expectedActive?.lastCommitId ?? null,
  }
  const header: MaterializationPlanHeader = {
    commit: {
      projectId: "contract-project",
      id: commitId,
      idempotencyKey: `projection:${commitId}`,
      requestHash: `hash:${commitId}`,
      origin: {
        kind: "projection",
        projectionId: candidate.source.projectionId,
        projectionRunId: candidate.execution.projectionRunId,
        datasetId: candidate.identity.datasetVersion.datasetId,
        datasetVersionId: candidate.identity.datasetVersion.versionId,
      },
      ontologyRevision: candidate.identity.ontologyRevision,
      projectionRevision: candidate.identity.projectionRevision,
      ownershipHash: candidate.identity.ownershipHash,
      intent: {
        kind: "projection",
        source: candidate.source,
        datasetVersion: candidate.identity.datasetVersion,
      },
      committedAt,
    },
    expected: { sources: [expected], objects: [], links: [], linkScopes: [], points: [] },
  }
  const finalization: MaterializationPlanFinalization = {
    sourceActivations: [
      {
        source: candidate.source,
        materializationId: candidate.materializationId,
        execution: candidate.execution,
        projectionKind: "object",
        protocol: "replacement",
        datasetVersion: candidate.identity.datasetVersion,
        projectionRevision: candidate.identity.projectionRevision,
        ownershipHash: candidate.identity.ownershipHash,
        ontologyRevision: candidate.identity.ontologyRevision,
        expected,
        lastCommitId: commitId,
        updatedAt: committedAt,
      },
    ],
    result: {
      kind: "projection",
      commitId,
      created: true,
      eventCount: 0,
      counts: emptyProjectionCounts,
    },
  }
  await storage.transaction(async (tx) => {
    if (!isProjectionMaterializationRunStorage(tx.projectionRuns)) {
      throw new Error("Contract transaction omitted required storage facades.")
    }
    await tx.projectionRuns.assertMaterializationExecution({
      id: candidate.execution.projectionRunId,
      projectId: header.commit.projectId,
      identity: candidate.identity,
      executionToken: candidate.execution.executionToken,
    })
    const session = await tx.ontology.materializations.begin(header)
    for (const entityKind of ["object", "link"] as const) {
      for await (const _page of tx.ontology.materializations.streamSourceReplacementState({
        session,
        source: candidate.source,
        candidateMaterializationId: candidate.materializationId,
        entityKind,
        pageRows: 1,
      })) {
        // Empty output intentionally has no classifications or exact writes.
      }
    }
    await tx.ontology.materializations.finalize({ session, finalization })
  })
}

function telemetryHeader(
  identity: ProjectionMaterializationIdentity,
  projectionRunId: string
): MaterializationPlanHeader {
  if (identity.protocol !== "telemetry") throw new Error("Expected telemetry identity")
  return {
    commit: {
      projectId: "contract-project",
      id: "telemetry-commit",
      idempotencyKey: "telemetry:telemetry-run:0",
      requestHash: "hash:telemetry-run:0",
      origin: {
        kind: "telemetry",
        source: {
          kind: "projection",
          projectionId: identity.projectionId,
          projectionRunId,
          datasetId: identity.datasetVersion.datasetId,
          datasetVersionId: identity.datasetVersion.versionId,
          batchOrdinal: 0,
        },
      },
      ontologyRevision: identity.ontologyRevision,
      projectionRevision: identity.projectionRevision,
      ownershipHash: identity.ownershipHash,
      intent: {
        kind: "telemetry",
        source: {
          kind: "projection",
          projection: { projectionId: identity.projectionId },
          datasetVersion: identity.datasetVersion,
          batchOrdinal: 0,
          sourceRowCount: 2,
          inputExhausted: true,
        },
        pointCount: 0,
        inputPointCount: 0,
      },
      committedAt: "2026-01-02T00:00:00.000Z",
    },
    expected: { sources: [], objects: [], links: [], linkScopes: [], points: [] },
  }
}
