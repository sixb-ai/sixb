/**
 * Service layer for link operations.
 *
 * Resolves objectTypeId to a typed context and delegates to leaf functions.
 */
import type { BatchItemResult, SixbRuntimeContext } from "../../runtime/types"
import type { ResolvedLinkBatchItem } from "../context"
import { requireLinkDefinition, resolveLinkContext, resolveObjectContext } from "../context"
import {
  removeLink as removeLinkLeaf,
  type SetLinkBatchOptions,
  setLinkBatch as setLinkBatchLeaf,
  upsertLinkBatch as upsertLinkBatchLeaf,
  upsertLink as upsertLinkLeaf,
} from "../link"

export async function upsertLink(
  runtime: SixbRuntimeContext,
  objectTypeId: string,
  sourceId: string,
  linkId: string,
  target: { targetTypeId: string; targetId: string; properties?: Record<string, unknown> }
): Promise<void> {
  const ctx = resolveObjectContext(runtime, objectTypeId)
  const linkCtx = resolveLinkContext(ctx, linkId)
  await upsertLinkLeaf(linkCtx, {
    sourceId,
    linkId,
    targetTypeId: target.targetTypeId,
    targetId: target.targetId,
    properties: target.properties,
  })
}

export async function upsertLinkBatch(
  runtime: SixbRuntimeContext,
  items: readonly {
    objectTypeId: string
    sourceId: string
    linkId: string
    target: { targetTypeId: string; targetId: string; properties?: Record<string, unknown> }
  }[]
): Promise<readonly BatchItemResult<void>[]> {
  const resolvedItems: ResolvedLinkBatchItem[] = items.map((item) => {
    const objectType = runtime.ontology.resolveObjectType(item.objectTypeId)
    const linkDefinition = requireLinkDefinition(objectType, item.linkId)
    return {
      objectType,
      linkDefinition,
      sourceId: item.sourceId,
      linkId: item.linkId,
      targetTypeId: item.target.targetTypeId,
      targetId: item.target.targetId,
      properties: item.target.properties,
    }
  })

  return upsertLinkBatchLeaf(runtime, resolvedItems)
}

export async function setLinkBatch(
  runtime: SixbRuntimeContext,
  items: readonly {
    objectTypeId: string
    sourceId: string
    linkId: string
    target: { targetTypeId: string; targetId: string }
  }[],
  options: SetLinkBatchOptions = {}
): Promise<readonly BatchItemResult<void>[]> {
  const resolvedItems: ResolvedLinkBatchItem[] = items.map((item) => {
    const objectType = runtime.ontology.resolveObjectType(item.objectTypeId)
    const linkDefinition = requireLinkDefinition(objectType, item.linkId)
    return {
      objectType,
      linkDefinition,
      sourceId: item.sourceId,
      linkId: item.linkId,
      targetTypeId: item.target.targetTypeId,
      targetId: item.target.targetId,
    }
  })

  return setLinkBatchLeaf(runtime, resolvedItems, options)
}

export async function removeLink(
  runtime: SixbRuntimeContext,
  objectTypeId: string,
  sourceId: string,
  linkId: string,
  target: { targetTypeId: string; targetId: string }
): Promise<void> {
  const ctx = resolveObjectContext(runtime, objectTypeId)
  const linkCtx = resolveLinkContext(ctx, linkId)
  await removeLinkLeaf(linkCtx, {
    sourceId,
    linkId,
    targetTypeId: target.targetTypeId,
    targetId: target.targetId,
  })
}
