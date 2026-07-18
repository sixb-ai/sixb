/**
 * Leaf operation: assign cardinality-one links in a serializable EditBatch.
 *
 * Assignment differs from an edge upsert: a different current target is deleted before the desired
 * target is created. Existence filtering and EditBatch planning share one transaction so a missing
 * target remains a per-item no-op even when objects change concurrently.
 */

import { assertPrivileged } from "../../authorization"
import { applyEditBatchCommit, runWithStorageSerializationRetry } from "../../edits/commit"
import type { EventDraft } from "../../events"
import type { ObjectTypeWithPropertyTokens } from "../../ontology/tokens"
import type { BatchItemResult, SixbRuntimeContext } from "../../runtime/types"
import { ObjectNotFoundError } from "../../storage/errors"
import type { ResolvedLinkBatchItem } from "../context"
import { ObjectError } from "../errors"

export interface SetLinkBatchOptions {
  readonly idempotencyKeyPrefix?: string
}

type ResolvedLinkSetBatchItem = Omit<ResolvedLinkBatchItem, "properties">

interface IndexedLinkSetItem {
  readonly index: number
  readonly item: ResolvedLinkSetBatchItem
}

interface MissingLinkSetItem {
  readonly index: number
  readonly error: ObjectNotFoundError
}

export async function setLinkBatch(
  ctx: SixbRuntimeContext,
  items: readonly ResolvedLinkSetBatchItem[],
  options: SetLinkBatchOptions = {}
): Promise<readonly BatchItemResult<void>[]> {
  assertPrivileged(ctx, "setLinkBatch")
  const { events, storage, projectId, ontology } = ctx

  if (items.length === 0) return []

  for (const item of items) {
    if (item.linkDefinition.cardinality !== "one") {
      throw new ObjectError(
        `setLinkBatch requires cardinality 'one' link '${item.objectType.id}.${item.linkId}'`
      )
    }
  }

  const indexed: readonly IndexedLinkSetItem[] = items.map((item, index) => ({ index, item }))
  const committedAt = new Date()

  let committed: {
    readonly events: readonly EventDraft[]
    readonly assignedIndices: readonly number[]
    readonly missingItems: readonly MissingLinkSetItem[]
  }
  try {
    committed = await runWithStorageSerializationRetry(() =>
      storage.transaction(
        async (tx) => {
          const existingMap = await tx.objects.getByPrimaryIdBatch({
            projectId,
            items: collectExistenceLookups(indexed),
          })
          const assignedItems: IndexedLinkSetItem[] = []
          const missingItems: MissingLinkSetItem[] = []

          for (const entry of indexed) {
            const { item } = entry
            const sourceKey = `${item.objectType.id}:${item.sourceId}`
            if (!existingMap.has(sourceKey)) {
              missingItems.push({
                index: entry.index,
                error: new ObjectNotFoundError(
                  item.objectType.id,
                  item.sourceId,
                  "Source object not found"
                ),
              })
              continue
            }

            const targetKey = `${item.targetTypeId}:${item.targetId}`
            if (!existingMap.has(targetKey)) {
              missingItems.push({
                index: entry.index,
                error: new ObjectNotFoundError(
                  item.targetTypeId,
                  item.targetId,
                  "Target object not found"
                ),
              })
              continue
            }

            assignedItems.push(entry)
          }

          if (assignedItems.length === 0) {
            return { events: [], assignedIndices: [], missingItems }
          }

          const editCommit = await applyEditBatchCommit({
            storage: tx,
            projectId,
            ontology,
            batch: {
              version: 1,
              operations: assignedItems.map(({ item }) => ({
                kind: "link.set" as const,
                source: { objectTypeId: item.objectType.id, primaryId: item.sourceId },
                linkId: item.linkId,
                target: { objectTypeId: item.targetTypeId, primaryId: item.targetId },
              })),
            },
            committedAt,
            ...(options.idempotencyKeyPrefix !== undefined
              ? { idempotencyKeyPrefix: options.idempotencyKeyPrefix }
              : {}),
          })

          return {
            events: editCommit.events,
            assignedIndices: assignedItems.map(({ index }) => index),
            missingItems,
          }
        },
        { isolation: "serializable" }
      )
    )
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    return items.map(() => ({ ok: false, error: normalized }))
  }

  // Match action commits: storage state is atomic, while mutation-event delivery is best effort.
  if (committed.events.length > 0) {
    try {
      await events.append({ events: committed.events })
    } catch (error) {
      console.error("[Sixb] Failed to emit cardinality-one link assignment events:", error)
    }
  }

  const results: BatchItemResult<void>[] = new Array(items.length)
  for (const { index, error } of committed.missingItems) {
    results[index] = { ok: false, error }
  }
  for (const index of committed.assignedIndices) {
    results[index] = { ok: true, value: undefined }
  }
  return results
}

function collectExistenceLookups(
  items: readonly {
    item: {
      objectType: ObjectTypeWithPropertyTokens
      sourceId: string
      targetTypeId: string
      targetId: string
    }
  }[]
): { objectTypeId: string; primaryId: string }[] {
  const lookups: { objectTypeId: string; primaryId: string }[] = []
  const keys = new Set<string>()

  for (const { item } of items) {
    const sourceKey = `${item.objectType.id}:${item.sourceId}`
    if (!keys.has(sourceKey)) {
      keys.add(sourceKey)
      lookups.push({ objectTypeId: item.objectType.id, primaryId: item.sourceId })
    }

    const targetKey = `${item.targetTypeId}:${item.targetId}`
    if (!keys.has(targetKey)) {
      keys.add(targetKey)
      lookups.push({ objectTypeId: item.targetTypeId, primaryId: item.targetId })
    }
  }

  return lookups
}
