import type { AuthorizablePrincipal } from "../execution/types"
import { createEventId } from "../materialization/identity"
import type {
  MaterializationPlanHeader,
  MaterializationWorkRecord,
  OntologyStorage,
} from "../storage/ontology"
import type { Storage } from "../storage/types"

export interface OntologyContractStorage extends Storage {
  readonly ontology: OntologyStorage
}

/** The request executor `ensureContractExecution` records for a contract commit. */
export function contractExecutor(id: string) {
  return { type: "request" as const, requestId: `contract-request:${id}` }
}

export function contractEditHeader(id: string): MaterializationPlanHeader {
  return {
    commit: {
      projectId: "contract-project",
      id,
      idempotencyKey: `runtime:${id}`,
      requestHash: `hash:${id}`,
      executionId: `contract-execution:${id}`,
      origin: { kind: "runtime", requestId: id },
      ontologyRevision: "ontology-contract-revision",
      intent: { kind: "edit", mode: "atomic", operationCount: 0 },
      committedAt: CONTRACT_COMMITTED_AT,
    },
    expected: {
      sources: [],
      objects: [],
      links: [],
      linkScopes: [],
      points: [],
    },
  }
}

export const CONTRACT_COMMITTED_AT = "2026-01-02T00:00:00.000Z"

export function contractEditResult(commitId: string, eventCount = 0) {
  return {
    kind: "edit" as const,
    commitId,
    created: true,
    eventCount,
    committedAt: CONTRACT_COMMITTED_AT,
    outcomes: [],
    changes: { objects: [], links: [] },
  }
}

export async function commitEmptyEdit(storage: OntologyContractStorage, id: string): Promise<void> {
  await storage.transaction(async (tx) => {
    const header = contractEditHeader(id)
    await ensureContractExecution(tx, header)
    const session = await tx.ontology.materializations.begin(header)
    await tx.ontology.materializations.apply({ session })
    await tx.ontology.materializations.finalize({
      session,
      finalization: { sourceActivations: [], result: contractEditResult(id) },
    })
  })
}

/**
 * Applies a provider-authored exact object row and matching outbox row. The
 * fixture contains no ontology merge or diff logic; all semantic decisions are
 * already represented by the exact plan.
 */
export async function commitExactObject(
  storage: OntologyContractStorage,
  id: string,
  options: {
    readonly primaryId?: string
    readonly omitFinalize?: boolean
    readonly throwAfterFinalize?: boolean
    /** Must name an existing auth principal: SQL providers reference it from the execution. */
    readonly requestedBy?: AuthorizablePrincipal
  } = {}
): Promise<{ readonly eventId: string }> {
  const header = contractEditHeader(id)
  const ref = { objectTypeId: "ContractDevice", primaryId: options.primaryId ?? id }
  const row = {
    ref,
    properties: { name: id },
    version: 1,
    createdAt: header.commit.committedAt,
    updatedAt: header.commit.committedAt,
    lastCommitId: id,
  }
  const exactWrite = { row, expected: { ref, exists: false as const } }
  const draft = {
    type: "object.created" as const,
    payload: {
      objectTypeId: ref.objectTypeId,
      primaryId: ref.primaryId,
      properties: row.properties,
    },
  }
  const work: readonly MaterializationWorkRecord[] = [
    {
      kind: "plan",
      recordKey: `plan:${id}`,
      applyPhase: 4,
      sortKey: "61",
      item: { kind: "object-upsert", value: exactWrite },
    },
    {
      kind: "event",
      recordKey: `event:0:${id}`,
      eventKindRank: 0,
      sortKey: "61",
      draft,
    },
  ]

  await storage.transaction(async (tx) => {
    await ensureContractExecution(tx, header, options.requestedBy)
    const materializations = tx.ontology.materializations
    const session = await materializations.begin(header)
    await materializations.stageWork({ session, records: work })

    await materializations.apply({ session })
    if (!options.omitFinalize) {
      await materializations.finalize({
        session,
        finalization: { sourceActivations: [], result: contractEditResult(id, 1) },
      })
    }
    if (options.throwAfterFinalize) throw new Error("contract rollback")
  })

  return { eventId: createEventId(header.commit.projectId, id, 0) }
}

/**
 * Records the execution a contract commit runs under: a request, made on behalf of `requestedBy`
 * when given. Its events read who asked and what wrote from this record.
 */
export async function ensureContractExecution(
  storage: Pick<Storage, "executions">,
  header: MaterializationPlanHeader,
  requestedBy?: AuthorizablePrincipal
): Promise<void> {
  if (
    await storage.executions.getById({
      projectId: header.commit.projectId,
      id: header.commit.executionId,
    })
  ) {
    return
  }
  await storage.executions.create({
    id: header.commit.executionId,
    projectId: header.commit.projectId,
    ...(requestedBy === undefined ? {} : { requestedBy }),
    executor: contractExecutor(header.commit.id),
    source: { type: "http", requestId: `contract-request:${header.commit.id}` },
    correlationId: `contract-correlation:${header.commit.id}`,
    authorizationRef:
      requestedBy === undefined
        ? { type: "disabled" }
        : { type: "principal", principal: requestedBy },
  })
}
