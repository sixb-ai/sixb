/**
 * Leaf operation: batch upsert links.
 *
 * Takes SixbRuntimeContext (shared infra) + per-item pre-resolved data,
 * because each item can target a different objectType + linkDefinition.
 */

import { assertPrivileged } from "../../authorization"
import type { EventDraft } from "../../events"
import { buildLinkUpsertMutationEvents } from "../../mutations"
import type { ObjectTypeWithPropertyTokens } from "../../ontology/tokens"
import { validateLinkBatch } from "../../ontology/validation"
import type { BatchItemResult, SixbRuntimeContext } from "../../runtime/types"
import { ObjectNotFoundError } from "../../storage/errors"
import type { ResolvedLinkBatchItem } from "../context"

export async function upsertLinkBatch(
  ctx: SixbRuntimeContext,
  items: readonly ResolvedLinkBatchItem[]
): Promise<readonly BatchItemResult<void>[]> {
  assertPrivileged(ctx, "upsertLinkBatch")
  const { events: eventsRuntime, storage, projectId, ontology } = ctx

  if (items.length === 0) return []

  const results: BatchItemResult<void>[] = new Array(items.length)

  // Storage existence checks
  const indexed = items.map((item, i) => ({
    index: i,
    item: {
      ...item,
      isValidLinkTarget: (expected: string | string[], actual: string) =>
        ontology.isValidLinkTarget(expected, actual),
    },
  }))

  const existenceLookups = collectExistenceLookups(indexed)
  const existingMap = await storage.objects.getByPrimaryIdBatch({
    projectId,
    items: existenceLookups,
  })

  const afterExistence: typeof indexed = []
  for (const entry of indexed) {
    const { item } = entry
    const sourceKey = `${item.objectType.id}:${item.sourceId}`
    if (!existingMap.has(sourceKey)) {
      results[entry.index] = {
        ok: false,
        error: new ObjectNotFoundError(
          item.objectType.id,
          item.sourceId,
          "Source object not found"
        ),
      }
      continue
    }
    const targetKey = `${item.targetTypeId}:${item.targetId}`
    if (!existingMap.has(targetKey)) {
      results[entry.index] = {
        ok: false,
        error: new ObjectNotFoundError(item.targetTypeId, item.targetId, "Target object not found"),
      }
      continue
    }
    afterExistence.push(entry)
  }
  if (afterExistence.length === 0) return results

  // Ontology validation (single call: target type + properties + cardinality)
  const linkLookups = collectLinkLookups(afterExistence)
  const linksMap = await storage.objects.listLinksBatch({ projectId, items: linkLookups })

  const validation = validateLinkBatch(afterExistence, linksMap, ontology.getValueTypesById())
  for (const { index, error } of validation.errors) results[index] = { ok: false, error }
  if (validation.valid.length === 0) return results

  // Append events, then project the stored events into object storage.
  const events: EventDraft[] = validation.valid.flatMap(({ item }) => {
    const sameLink = (
      linksMap.get(`${item.objectType.id}:${item.sourceId}:${item.linkId}`) ?? []
    ).find(
      (candidate) =>
        candidate.targetTypeId === item.targetTypeId && candidate.targetId === item.targetId
    )
    return buildLinkUpsertMutationEvents({
      sourceTypeId: item.objectType.id,
      sourceId: item.sourceId,
      linkId: item.linkId,
      targetTypeId: item.targetTypeId,
      targetId: item.targetId,
      operation: sameLink ? "update" : "create",
      previousProperties: sameLink?.properties,
      ...(item.properties !== undefined ? { properties: item.properties } : {}),
    })
  })

  const appended = await eventsRuntime.append({ events })
  const linkEvents = appended.filter(
    (e): e is Extract<typeof e, { type: "link.upserted" }> => e.type === "link.upserted"
  )

  await storage.objects.applyLinkUpsertedBatch(linkEvents)

  for (const entry of validation.valid) {
    results[entry.index] = { ok: true, value: undefined }
  }

  return results
}

function collectExistenceLookups(
  items: {
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

function collectLinkLookups(
  items: {
    item: { objectType: ObjectTypeWithPropertyTokens; sourceId: string; linkId: string }
  }[]
): { objectTypeId: string; objectId: string; linkId: string }[] {
  const lookups: { objectTypeId: string; objectId: string; linkId: string }[] = []
  const keys = new Set<string>()

  for (const { item } of items) {
    const key = `${item.objectType.id}:${item.sourceId}:${item.linkId}`
    if (!keys.has(key)) {
      keys.add(key)
      lookups.push({
        objectTypeId: item.objectType.id,
        objectId: item.sourceId,
        linkId: item.linkId,
      })
    }
  }

  return lookups
}
