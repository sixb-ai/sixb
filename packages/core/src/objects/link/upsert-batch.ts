/**
 * Leaf operation: batch upsert links.
 *
 * Takes SixbRuntimeContext (shared infra) + per-item pre-resolved data,
 * because each item can target a different objectType + linkDefinition.
 */

import { assertPrivileged } from "../../authorization"
import { buildLinkUpsertEvent, hasPropertyChanges } from "../../events"
import type { ObjectTypeWithPropertyTokens } from "../../ontology/tokens"
import { normalizeLinkProperties, validateLinkBatch } from "../../ontology/validation"
import type { BatchItemResult, SixbRuntimeContext } from "../../runtime/types"
import { ObjectNotFoundError } from "../../storage/errors"
import type { ResolvedLinkBatchItem } from "../context"
import { ObjectError } from "../errors"

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

  const valueTypesById = ontology.getValueTypesById()
  const validation = validateLinkBatch(afterExistence, linksMap, valueTypesById)
  for (const { index, error } of validation.errors) results[index] = { ok: false, error }
  if (validation.valid.length === 0) return results

  // Plan mutations and resolve unchanged items before touching the event stream.
  const mutations: {
    index: number
    event: ReturnType<typeof buildLinkUpsertEvent>
  }[] = []

  for (const { index, item } of validation.valid) {
    const sameLink = (
      linksMap.get(`${item.objectType.id}:${item.sourceId}:${item.linkId}`) ?? []
    ).find(
      (candidate) =>
        candidate.targetTypeId === item.targetTypeId && candidate.targetId === item.targetId
    )
    const normalizedProperties = normalizeLinkProperties(
      item.objectType,
      item.linkDefinition,
      item.properties,
      valueTypesById
    )
    const mergedProperties =
      normalizedProperties !== undefined || sameLink?.properties !== undefined
        ? {
            ...(sameLink?.properties ?? {}),
            ...(normalizedProperties ?? {}),
          }
        : undefined

    const event = buildLinkUpsertEvent({
      sourceTypeId: item.objectType.id,
      sourceId: item.sourceId,
      linkId: item.linkId,
      targetTypeId: item.targetTypeId,
      targetId: item.targetId,
      operation: sameLink ? "update" : "create",
      previousProperties: sameLink?.properties,
      ...(mergedProperties !== undefined ? { properties: mergedProperties } : {}),
    })

    if (sameLink && !hasPropertyChanges(event.payload.propertyChanges)) {
      results[index] = { ok: true, value: undefined }
      continue
    }

    mutations.push({ index, event })
  }

  if (mutations.length === 0) return results

  // Append changed events, then project the stored events into object storage.
  const appended = await eventsRuntime.append({ events: mutations.map(({ event }) => event) })
  const linkEvents = appended.filter(
    (event): event is Extract<typeof event, { type: "link.created" | "link.updated" }> =>
      event.type === "link.created" || event.type === "link.updated"
  )
  if (linkEvents.length !== mutations.length) {
    throw new ObjectError("Failed to append link mutation event batch")
  }

  await storage.objects.applyLinkUpsertBatch(linkEvents)

  for (const { index } of mutations) {
    results[index] = { ok: true, value: undefined }
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
