/**
 * ObjectSet provides a type-safe collection API for objects of a given type.
 * Created via `sixb.objects(MyType)`, it exposes upsert, query, and telemetry batch operations
 * while preserving compile-time property types inferred from the ontology definition.
 */

import type { ActionDefinition, ActionRegistry } from "../../actions"
import type { BlobStorage } from "../../blob-storage"
import type { EventsRuntime } from "../../events"
import type { LakeStorage } from "../../lake-storage"
import type { OntologyRegistry, ValueType } from "../../ontology"
import { OntologyValidationError } from "../../ontology/errors"
import type { ObjectTypeWithPropertyTokens } from "../../ontology/tokens"
import type { Queues } from "../../queues"
import type { ObjectSet, ObjectSetListInput, TwinObject } from "../../runtime/types"
import type { Storage } from "../../storage"
import {
  requestActionAndWait as requestActionAndWaitLeaf,
  requestAction as requestActionLeaf,
} from "../action"
import type { ResolvedLinkContext, ResolvedObjectContext } from "../context"
import { requireLinkDefinition } from "../context"
import { removeLink as removeLinkLeaf, upsertLink as upsertLinkLeaf } from "../link"
import { upsertObject as upsertObjectLeaf } from "../object"
import { appendTelemetryBatch as appendTelemetryBatchLeaf } from "../telemetry"
import { createObjectByIdHandle } from "./object-handle"
import { createObjectQueryBuilder } from "./query-builder"

export function createObjectSet<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TRegisteredObjectTypes extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
>(params: {
  objectType: TObjectType
  projectId: string
  ontology: OntologyRegistry
  actionRegistry: ActionRegistry
  events: EventsRuntime
  lakeStorage: LakeStorage
  blobStorage: BlobStorage
  storage: Storage
  queues: Queues
}): ObjectSet<TObjectType, TValueTypes, TRegisteredObjectTypes> {
  const {
    objectType,
    projectId,
    ontology,
    actionRegistry,
    events,
    lakeStorage,
    blobStorage,
    storage,
    queues,
  } = params

  const primaryProp = objectType.properties.find((p) => p.primary)
  if (!primaryProp) {
    throw new OntologyValidationError(`Object type '${objectType.id}' has no primary property`)
  }
  const primaryPropertyId = primaryProp.id

  const resolvedCtx: ResolvedObjectContext = {
    projectId,
    ontology,
    actionRegistry,
    events,
    lakeStorage,
    blobStorage,
    storage,
    queues,
    objectType,
    primaryPropertyId,
  }

  const objectSet = {
    get: async (id: string) => {
      const row = await storage.objects.getByPrimaryId({
        projectId,
        objectTypeId: objectType.id,
        primaryId: id,
      })
      return row ? (row as unknown as TwinObject<TObjectType, TValueTypes>) : null
    },

    upsert: async (input: { properties: Record<string, unknown> }) => {
      const primaryId = input.properties[primaryPropertyId]
      if (primaryId === undefined || primaryId === null) {
        throw new OntologyValidationError(
          `Missing primary property '${primaryPropertyId}' in upsert for '${objectType.id}'`
        )
      }
      const row = await upsertObjectLeaf(resolvedCtx, String(primaryId), input.properties)
      return row as unknown as TwinObject<TObjectType, TValueTypes>
    },

    query: () =>
      createObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes>({
        objectType,
        ontology,
        projectId,
        storage,
        query: { kind: "start", objectTypeId: objectType.id },
      }),

    byId: (id: string) => createObjectByIdHandle<TObjectType, TValueTypes>(resolvedCtx, id),

    list: async (input?: ObjectSetListInput) => {
      const result = await storage.objects.list({
        projectId,
        objectTypeId: objectType.id,
        primaryIdPrefix: input?.idPrefix,
        primaryIdSuffix: input?.idSuffix,
        updatedAfter: input?.updatedAfter,
        updatedBefore: input?.updatedBefore,
        createdAfter: input?.createdAfter,
        createdBefore: input?.createdBefore,
        limit: input?.limit,
        offset: input?.offset,
        orderBy: input?.orderBy,
        order: input?.order,
      })

      return {
        objects: result.objects.map(
          (row) => row as unknown as TwinObject<TObjectType, TValueTypes>
        ),
        hasMore: result.hasMore,
        total: result.total ?? result.objects.length,
      }
    },

    appendTelemetryBatch: async (
      items: readonly {
        id: string
        properties: Record<string, unknown | { value: unknown; unit: string }>
        at?: Date
      }[]
    ) => {
      await appendTelemetryBatchLeaf(resolvedCtx, items)
    },

    requestAction: async (input: {
      id: string
      action?: ActionDefinition
      actionId?: string
      params?: Record<string, unknown>
      runId?: string
    }) => {
      const actionId = input.action?.id ?? input.actionId
      if (!actionId) {
        throw new OntologyValidationError(
          "[Sixb] requestAction requires either 'action' or 'actionId'"
        )
      }
      return requestActionLeaf(resolvedCtx, {
        primaryId: input.id,
        actionId,
        params: input.params,
        options: { runId: input.runId },
      })
    },

    requestActionAndWait: async (input: {
      id: string
      action?: ActionDefinition
      actionId?: string
      params?: Record<string, unknown>
      timeoutMs?: number
      signal?: AbortSignal
    }) => {
      const actionId = input.action?.id ?? input.actionId
      if (!actionId) {
        throw new OntologyValidationError(
          "[Sixb] requestActionAndWait requires either 'action' or 'actionId'"
        )
      }
      return requestActionAndWaitLeaf(resolvedCtx, {
        primaryId: input.id,
        actionId,
        params: input.params,
        options: {
          timeoutMs: input.timeoutMs,
          signal: input.signal,
        },
      })
    },

    upsertLink: async (input: {
      sourceId: string
      linkId: string
      targetTypeId: string
      targetId: string
      properties?: Record<string, unknown>
    }) => {
      const linkDefinition = requireLinkDefinition(objectType, input.linkId)
      const linkCtx: ResolvedLinkContext = { ...resolvedCtx, linkDefinition }

      await upsertLinkLeaf(linkCtx, {
        sourceId: input.sourceId,
        linkId: input.linkId,
        targetTypeId: input.targetTypeId,
        targetId: input.targetId,
        properties: input.properties,
      })
    },

    removeLink: async (input: {
      sourceId: string
      linkId: string
      targetTypeId: string
      targetId: string
    }) => {
      const linkDefinition = requireLinkDefinition(objectType, input.linkId)
      const linkCtx: ResolvedLinkContext = { ...resolvedCtx, linkDefinition }

      await removeLinkLeaf(linkCtx, {
        sourceId: input.sourceId,
        linkId: input.linkId,
        targetTypeId: input.targetTypeId,
        targetId: input.targetId,
      })
    },
  }

  return objectSet as unknown as ObjectSet<TObjectType, TValueTypes, TRegisteredObjectTypes>
}
