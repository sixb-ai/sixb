/**
 * ObjectSet provides a type-safe collection API for objects of a given type.
 * Created via `sixb.objects(MyType)`, it exposes upsert, query, and telemetry batch operations
 * while preserving compile-time property types inferred from the ontology definition.
 */

import type { ActionDefinition } from "../../actions"
import { assertAuthorized } from "../../authorization"
import { shareSixbErrorReporter } from "../../error-reporting/capability"
import type { ExecutionContext } from "../../execution"
import { assertAuthorizedObjectReaderBinding } from "../../execution/authorized-object-reader"
import type { ValueType } from "../../ontology"
import { OntologyValidationError } from "../../ontology/errors"
import type { ObjectTypeWithPropertyTokens } from "../../ontology/tokens"
import { shareOntologyMutationRuntime } from "../../runtime/ontology-mutations"
import type {
  ObjectSet,
  ObjectSetListInput,
  SixbRuntimeContext,
  TwinObject,
} from "../../runtime/types"
import {
  requestActionAndWait as requestActionAndWaitLeaf,
  requestAction as requestActionLeaf,
} from "../action"
import type { ExecutionObjectContext, ResolvedLinkContext } from "../context"
import { requireLinkDefinition } from "../context"
import { removeLink as removeLinkLeaf, upsertLink as upsertLinkLeaf } from "../link"
import { upsertObject as upsertObjectLeaf } from "../object"
import { assertObjectListWithinWindow, resolveObjectListWindow } from "../service/list-window"
import { appendTelemetryBatch as appendTelemetryBatchLeaf } from "../telemetry"
import { createObjectByIdHandle } from "./object-handle"
import { createObjectQueryBuilder } from "./query-builder"
import { createRuntimeQueryExecutor } from "./runtime-query-executor"

export function createObjectSet<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TRegisteredObjectTypes extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
>(
  params: SixbRuntimeContext & {
    readonly execution: ExecutionContext
    readonly objectType: TObjectType
  }
): ObjectSet<TObjectType, TValueTypes, TRegisteredObjectTypes> {
  assertAuthorizedObjectReaderBinding({
    reader: params.objectReader,
    scope: { execution: params.execution, authorization: params.runtimeAuthorization },
  })
  const { objectType } = params
  const primaryProp = objectType.properties.find((p) => p.primary)
  if (!primaryProp) {
    throw new OntologyValidationError(`Object type '${objectType.id}' has no primary property`)
  }
  const primaryPropertyId = primaryProp.id

  const {
    projectId,
    broker,
    ontology,
    actionRegistry,
    events,
    storage,
    objectReader,
    queues,
    runtimeAuthorization,
    authorization,
    execution,
  } = params
  const queryExecutor = createRuntimeQueryExecutor({
    ontology,
    objectReader,
  })

  const resolvedCtx: ExecutionObjectContext = {
    projectId,
    broker,
    ontology,
    actionRegistry,
    events,
    storage,
    objectReader,
    queues,
    runtimeAuthorization,
    authorization,
    execution,
    objectType,
    primaryPropertyId,
  }
  shareOntologyMutationRuntime(params, resolvedCtx)
  shareSixbErrorReporter(params, resolvedCtx)

  const objectSet = {
    get: async (id: string) => {
      assertAuthorized(resolvedCtx, { kind: "object.view", objectTypeId: objectType.id })
      const row = await objectReader.getByPrimaryId({
        objectTypeId: objectType.id,
        primaryId: id,
      })
      return row ? (row as unknown as TwinObject<TObjectType, TValueTypes>) : null
    },

    upsert: async (input: { properties: Record<string, unknown> }) => {
      const row = await upsertObjectLeaf(resolvedCtx, input.properties)
      return row as unknown as TwinObject<TObjectType, TValueTypes>
    },

    query: () =>
      createObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes>({
        query: { kind: "start", objectTypeId: objectType.id },
        executor: queryExecutor,
      }),

    byId: (id: string) => createObjectByIdHandle<TObjectType, TValueTypes>(resolvedCtx, id),

    list: async (input?: ObjectSetListInput) => {
      const window = resolveObjectListWindow(resolvedCtx, input ?? {})
      assertAuthorized(resolvedCtx, { kind: "object.view", objectTypeId: objectType.id })
      const result = await objectReader.list({
        objectTypeId: objectType.id,
        primaryIdPrefix: input?.idPrefix,
        primaryIdSuffix: input?.idSuffix,
        updatedAfter: input?.updatedAfter,
        updatedBefore: input?.updatedBefore,
        createdAfter: input?.createdAfter,
        createdBefore: input?.createdBefore,
        limit: window.limit,
        offset: window.offset,
        orderBy: input?.orderBy,
        order: input?.order,
      })
      assertObjectListWithinWindow(window, result.objects.length)

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
