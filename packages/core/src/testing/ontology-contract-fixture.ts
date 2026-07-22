import { createEventId } from "../materialization/identity"
import type {
  MaterializationPlanHeader,
  MaterializationWorkRecord,
  OntologyMaterializationEvent,
  OntologyStorage,
} from "../storage/ontology"
import type { Storage } from "../storage/types"

export interface OntologyContractStorage extends Storage {
  readonly ontology: OntologyStorage
}

const emptyChunk = {
  overrides: { objectUpserts: [], objectDeletes: [], linkUpserts: [], linkDeletes: [] },
  effective: {
    objectUpserts: [],
    objectDeletes: [],
    linkUpserts: [],
    linkDeletes: [],
  },
  timeseries: { pointUpserts: [] },
  outbox: [],
} as const

export function contractEditHeader(id: string): MaterializationPlanHeader {
  return {
    commit: {
      projectId: "contract-project",
      id,
      idempotencyKey: `runtime:${id}`,
      requestHash: `hash:${id}`,
      origin: { kind: "runtime", requestId: id },
      ontologyRevision: "ontology-contract-revision",
      intent: { kind: "edit", mode: "atomic", operationCount: 0 },
      committedAt: "2026-01-02T00:00:00.000Z",
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

export function contractEditResult(commitId: string, eventCount = 0) {
  return {
    kind: "edit" as const,
    commitId,
    created: true,
    eventCount,
    outcomes: [],
    changes: { objects: [], links: [] },
  }
}

export async function commitEmptyEdit(storage: OntologyContractStorage, id: string): Promise<void> {
  await storage.transaction(async (tx) => {
    if (!tx.ontology) throw new Error("[Sixb] Contract transaction omitted ontology storage.")
    const session = await tx.ontology.materializations.begin(contractEditHeader(id))
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
  options: { readonly primaryId?: string; readonly throwAfterFinalize?: boolean } = {}
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
    schemaVersion: 1 as const,
    projectId: header.commit.projectId,
    occurredAt: header.commit.committedAt,
    origin: header.commit.origin,
    commitId: id,
    type: "object.created" as const,
    topic: "objects" as const,
    partitionKey: `${ref.objectTypeId}:${ref.primaryId}`,
    payload: {
      objectTypeId: ref.objectTypeId,
      primaryId: ref.primaryId,
      properties: row.properties,
      propertyChanges: {},
    },
  }
  const eventId = createEventId(header.commit.projectId, id, 0)
  const envelope: OntologyMaterializationEvent = {
    ...draft,
    id: eventId,
    commitOrdinal: 0,
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
    if (!tx.ontology) throw new Error("[Sixb] Contract transaction omitted ontology storage.")
    const materializations = tx.ontology.materializations
    const session = await materializations.begin(header)
    await materializations.stageWork({ session, records: work })

    const applyRecords = []
    for await (const page of materializations.streamWork({
      session,
      order: "apply",
      pageRows: 1,
    })) {
      applyRecords.push(...page.records)
    }
    const objectUpserts = applyRecords.flatMap((record) =>
      record.kind === "plan" && record.item.kind === "object-upsert" ? [record.item.value] : []
    )
    await materializations.applyChunk({
      session,
      chunk: {
        ...emptyChunk,
        effective: { ...emptyChunk.effective, objectUpserts },
      },
    })

    const eventRecords = []
    for await (const page of materializations.streamWork({
      session,
      order: "event",
      pageRows: 1,
    })) {
      eventRecords.push(...page.records)
    }
    await materializations.applyChunk({
      session,
      chunk: {
        ...emptyChunk,
        outbox: eventRecords.map((record) => {
          if (record.kind !== "event") throw new Error("Expected event work record.")
          return {
            envelope,
            availableAt: header.commit.committedAt,
            createdAt: header.commit.committedAt,
          }
        }),
      },
    })
    await materializations.finalize({
      session,
      finalization: { sourceActivations: [], result: contractEditResult(id, 1) },
    })
    if (options.throwAfterFinalize) throw new Error("contract rollback")
  })

  return { eventId }
}
