import type { ObjectLinkRow } from "../../storage"
import type { ObjectLink, ValueType } from ".."
import { OntologyValidationError } from "../errors"
import type { ObjectTypeWithPropertyTokens } from "../tokens"
import { assertLinkTargetType, validateLinkProperties } from "./links"
import {
  assertKnownProperties,
  assertRequiredProperties,
  validateObjectProperties,
} from "./properties"

/** Per-item result of a batch validation pass. */
export type BatchValidationResult<T> = {
  valid: { index: number; item: T }[]
  errors: { index: number; error: Error }[]
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

/**
 * Single-pass object batch validator.
 *
 * For each item: assertKnownProperties → validateObjectProperties →
 * extract primaryId → merge with existing state → assertRequiredProperties.
 *
 * Mirrors the single-item `upsertObject` validation sequence.
 */
export function validateObjectBatch(
  objectType: ObjectTypeWithPropertyTokens,
  primaryPropertyId: string,
  items: readonly { properties: Record<string, unknown> }[],
  existingMap: Map<string, { properties: Record<string, unknown> }>,
  valueTypesById: ReadonlyMap<string, ValueType>
): BatchValidationResult<{ primaryId: string; properties: Record<string, unknown> }> {
  const valid: BatchValidationResult<{
    primaryId: string
    properties: Record<string, unknown>
  }>["valid"] = []
  const errors: BatchValidationResult<unknown>["errors"] = []

  for (let i = 0; i < items.length; i++) {
    const { properties } = items[i]
    try {
      assertKnownProperties(objectType, properties)
      validateObjectProperties(objectType, properties, valueTypesById)

      const primaryId = properties[primaryPropertyId]
      if (primaryId === undefined || primaryId === null) {
        throw new OntologyValidationError(
          `[Pario] Missing primary property '${primaryPropertyId}' in upsert for '${objectType.id}'`
        )
      }

      const existing = existingMap.get(`${objectType.id}:${String(primaryId)}`)
      const mergedProperties = { ...(existing?.properties ?? {}), ...properties }
      assertRequiredProperties(objectType, mergedProperties)

      valid.push({ index: i, item: { primaryId: String(primaryId), properties } })
    } catch (e) {
      errors.push({ index: i, error: toError(e) })
    }
  }

  return { valid, errors }
}

/**
 * Single-pass link batch validator.
 *
 * For each item: assertLinkTargetType → validateLinkProperties →
 * cardinality check.
 *
 * Mirrors the single-item `upsertLink` validation sequence.
 */
export function validateLinkBatch<
  T extends {
    objectType: ObjectTypeWithPropertyTokens
    sourceId: string
    linkDefinition: ObjectLink
    linkId: string
    targetTypeId: string
    targetId: string
    properties?: Record<string, unknown>
    isValidLinkTarget?: (expected: string | string[], actual: string) => boolean
  },
>(
  items: { index: number; item: T }[],
  linksMap: Map<string, ObjectLinkRow[]>,
  valueTypesById: ReadonlyMap<string, ValueType>
): BatchValidationResult<T> {
  const valid: BatchValidationResult<T>["valid"] = []
  const errors: BatchValidationResult<T>["errors"] = []

  for (const entry of items) {
    const { item } = entry
    try {
      assertLinkTargetType(
        item.objectType.id,
        item.linkId,
        item.linkDefinition,
        item.targetTypeId,
        item.isValidLinkTarget
      )

      const key = `${item.objectType.id}:${item.sourceId}:${item.linkId}`
      const existingLinks = linksMap.get(key) ?? []

      const sameLink = existingLinks.find(
        (existing) =>
          existing.targetTypeId === item.targetTypeId && existing.targetId === item.targetId
      )

      validateLinkProperties(
        item.objectType,
        item.linkDefinition,
        item.properties,
        sameLink?.properties,
        valueTypesById
      )

      if (item.linkDefinition.cardinality === "one") {
        const conflicting = existingLinks.find(
          (existing) =>
            existing.targetTypeId !== item.targetTypeId || existing.targetId !== item.targetId
        )
        if (conflicting) {
          throw new OntologyValidationError(
            `[Pario] Link ${item.objectType.id}.${item.linkId} has cardinality 'one'` +
              ` and already points to ${conflicting.targetTypeId}:${conflicting.targetId}`
          )
        }
      }

      valid.push(entry)
    } catch (e) {
      errors.push({ index: entry.index, error: toError(e) })
    }
  }

  return { valid, errors }
}
