import { MaterializationValidationError } from "../../materialization/errors"
import { utf8JsonByteLength } from "../../materialization/refs"
import type {
  MaterializationSession,
  MaterializationWorkRecord,
  OntologyMaterializationStorage,
} from "../../storage/ontology"
import type { MaterializerContext } from "../context"
import { sequenceMaterializationEvent } from "../effective/build-events"
import { throwIfAborted } from "../shared/abort"
import { chunkBySize } from "../shared/chunking"
import type { TimedCommitIdentity } from "../shared/identity"
import { type MaterializationPlanItem, planStream } from "./plan-stream"
import { outboxItem } from "./work-records"

type BatchingContext = Pick<MaterializerContext, "batching">

type EventContext = Pick<MaterializerContext, "batching" | "projectId">

export async function applyItems(
  context: BatchingContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  items: Iterable<MaterializationPlanItem>,
  signal?: AbortSignal
): Promise<void> {
  for await (const chunk of planStream(items, context.batching)) {
    throwIfAborted(signal)
    await storage.applyChunk({ session, chunk })
  }
}

export async function stageWorkBounded(
  context: BatchingContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  records: readonly MaterializationWorkRecord[]
): Promise<void> {
  for await (const chunk of chunkBySize(records, {
    maxRows: context.batching.planChunkRows,
    maxBytes: context.batching.planChunkBytes,
    byteLength: utf8JsonByteLength,
  })) {
    await storage.stageWork({ session, records: chunk })
  }
}

export async function drainStagedWork(
  context: BatchingContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  signal?: AbortSignal
): Promise<void> {
  let phase: number | null = null
  let pending: MaterializationPlanItem[] = []
  const flush = async () => {
    if (pending.length === 0) return
    await applyItems(context, storage, session, pending, signal)
    pending = []
  }
  for await (const page of storage.streamWork({
    session,
    order: "apply",
    pageRows: context.batching.planChunkRows,
  })) {
    for (const record of page.records) {
      if (record.kind !== "plan") {
        throw new MaterializationValidationError("Provider returned non-plan apply work.")
      }
      if (phase !== null && record.applyPhase !== phase) await flush()
      phase = record.applyPhase
      pending.push(record.item)
      if (pending.length >= context.batching.planChunkRows) await flush()
    }
  }
  await flush()
}

export async function validateStagedCardinality(
  context: BatchingContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  signal?: AbortSignal
): Promise<void> {
  let currentScope: string | null = null
  let occupant: string | null = null
  for await (const page of storage.streamWork({
    session,
    order: "cardinality",
    pageRows: context.batching.statePageRows,
  })) {
    throwIfAborted(signal)
    for (const record of page.records) {
      if (record.kind !== "cardinality") {
        throw new MaterializationValidationError(
          "Provider returned non-cardinality cardinality work."
        )
      }
      if (record.scopeSortKey !== currentScope) {
        currentScope = record.scopeSortKey
        occupant = null
      }
      if (!record.occupied) continue
      if (occupant && occupant !== record.linkSortKey) {
        throw new MaterializationValidationError(
          `Link scope '${record.ref.source.objectTypeId}.${record.ref.linkId}' has cardinality one.`
        )
      }
      occupant = record.linkSortKey
    }
  }
}

export async function drainStagedEvents(
  context: EventContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  identity: TimedCommitIdentity,
  signal?: AbortSignal
): Promise<number> {
  let ordinal = 0
  for await (const page of storage.streamWork({
    session,
    order: "event",
    pageRows: context.batching.planChunkRows,
  })) {
    const items: MaterializationPlanItem[] = []
    for (const record of page.records) {
      if (record.kind !== "event") {
        throw new MaterializationValidationError("Provider returned non-event event work.")
      }
      const event = sequenceMaterializationEvent(
        context.projectId,
        identity.commitId,
        ordinal++,
        record.draft
      )
      items.push(outboxItem(event, identity.committedAt))
    }
    await applyItems(context, storage, session, items, signal)
  }
  return ordinal
}
