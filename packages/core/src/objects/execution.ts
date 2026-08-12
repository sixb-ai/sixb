import { assertAuthorized, isAllowed } from "../authorization"
import type { ValueType } from "../ontology"
import { assertObjectTypeRegistered } from "../ontology"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import type {
  ListResult,
  ObjectByIdHandle,
  ObjectSet,
  OntologySource,
  RegisteredObjectType,
  RegisteredValueTypes,
  SixbRuntimeContext,
} from "../runtime/types"
import type {
  LinkDirection,
  ObjectLinkRow,
  ObjectRow,
  TimeseriesHistoryBatchInput,
  TimeseriesHistoryBatchResult,
  TimeseriesPoint,
} from "../storage"
import {
  countObjects,
  type ExecuteObjectCountInput,
  type ExecuteObjectCountResult,
  type ExecuteObjectExistsInput,
  type ExecuteObjectExistsResult,
  type ExecuteObjectFacetsInput,
  type ExecuteObjectFacetsResult,
  type ExecuteObjectQueryInput,
  type ExecuteObjectQueryResult,
  executeObjectQuery,
  existsObjects,
  facetObjects,
} from "./query"
import { createObjectSet } from "./sdk"
import type { ListObjectsParams } from "./service"
import * as objectService from "./service"
import { getTelemetryHistoryBatch } from "./telemetry"

export interface ExecutionObjectOperations {
  listTypes(): readonly ObjectTypeWithPropertyTokens[]
  getTypeById(objectTypeId: string): ObjectTypeWithPropertyTokens | null
  resolveType(objectTypeId: string): ObjectTypeWithPropertyTokens
  getValueTypesById(): ReturnType<SixbRuntimeContext["ontology"]["getValueTypesById"]>
  getPrimaryPropertyId(objectTypeId: string): string
  listSubTypes(objectTypeId: string): string[]
  isValidLinkTarget(expected: string | string[], actual: string): boolean
  get(objectTypeId: string, primaryId: string): Promise<ObjectRow | null>
  list(params: ListObjectsParams): Promise<ListResult<ObjectRow>>
  upsert(objectTypeId: string, properties: Record<string, unknown>): Promise<ObjectRow>
  upsertBatch(
    objectTypeId: string,
    items: readonly { properties: Record<string, unknown> }[]
  ): ReturnType<typeof objectService.upsertObjectBatch>
  appendTelemetry(
    objectTypeId: string,
    items: readonly { id: string; properties: Record<string, unknown>; at?: Date }[]
  ): Promise<void>
  upsertLink(
    objectTypeId: string,
    sourceId: string,
    linkId: string,
    target: { targetTypeId: string; targetId: string; properties?: Record<string, unknown> }
  ): Promise<void>
  upsertLinkBatch(
    items: readonly {
      objectTypeId: string
      sourceId: string
      linkId: string
      target: { targetTypeId: string; targetId: string; properties?: Record<string, unknown> }
    }[]
  ): ReturnType<typeof objectService.upsertLinkBatch>
  removeLink(
    objectTypeId: string,
    sourceId: string,
    linkId: string,
    target: { targetTypeId: string; targetId: string }
  ): Promise<void>
}

export interface ExecutionObjectByIdHandle<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
> {
  get: ObjectByIdHandle<TObjectType, TValueTypes>["get"]
  listLinks: ObjectByIdHandle<TObjectType, TValueTypes>["listLinks"]
  requestAction: ObjectByIdHandle<TObjectType, TValueTypes>["requestAction"]
  requestActionAndWait: ObjectByIdHandle<TObjectType, TValueTypes>["requestActionAndWait"]
  link: ObjectByIdHandle<TObjectType, TValueTypes>["link"]
  unlink: ObjectByIdHandle<TObjectType, TValueTypes>["unlink"]
  delete: ObjectByIdHandle<TObjectType, TValueTypes>["delete"]
  restore: ObjectByIdHandle<TObjectType, TValueTypes>["restore"]
  telemetry: ObjectByIdHandle<TObjectType, TValueTypes>["telemetry"]
}

export interface ExecutionObjectSet<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
  TRegisteredObjectTypes extends ObjectTypeWithPropertyTokens = TObjectType,
> {
  get: ObjectSet<TObjectType, TValueTypes, TRegisteredObjectTypes>["get"]
  list: ObjectSet<TObjectType, TValueTypes, TRegisteredObjectTypes>["list"]
  query: ObjectSet<TObjectType, TValueTypes, TRegisteredObjectTypes>["query"]
  requestAction: ObjectSet<TObjectType, TValueTypes, TRegisteredObjectTypes>["requestAction"]
  requestActionAndWait: ObjectSet<
    TObjectType,
    TValueTypes,
    TRegisteredObjectTypes
  >["requestActionAndWait"]
  upsert: ObjectSet<TObjectType, TValueTypes, TRegisteredObjectTypes>["upsert"]
  upsertLink: ObjectSet<TObjectType, TValueTypes, TRegisteredObjectTypes>["upsertLink"]
  removeLink: ObjectSet<TObjectType, TValueTypes, TRegisteredObjectTypes>["removeLink"]
  appendTelemetryBatch: ObjectSet<
    TObjectType,
    TValueTypes,
    TRegisteredObjectTypes
  >["appendTelemetryBatch"]

  byId(id: string): ExecutionObjectByIdHandle<TObjectType, TValueTypes>
}

export interface ObjectsRuntime<TOntologySources extends readonly OntologySource[]>
  extends ExecutionObjectOperations {
  <TObjectType extends RegisteredObjectType<TOntologySources>>(
    objectType: TObjectType
  ): ExecutionObjectSet<
    TObjectType,
    RegisteredValueTypes<TOntologySources>,
    RegisteredObjectType<TOntologySources>
  >
  executeQuery(input: Omit<ExecuteObjectQueryInput, "projectId">): Promise<ExecuteObjectQueryResult>
  count(input: Omit<ExecuteObjectCountInput, "projectId">): Promise<ExecuteObjectCountResult>
  exists(input: Omit<ExecuteObjectExistsInput, "projectId">): Promise<ExecuteObjectExistsResult>
  facet(input: Omit<ExecuteObjectFacetsInput, "projectId">): Promise<ExecuteObjectFacetsResult>
  listLinks(input: {
    readonly objectTypeId: string
    readonly objectId: string
    readonly linkId?: string
    readonly direction?: LinkDirection
  }): Promise<readonly ObjectLinkRow[]>
  getTelemetryHistoryBatch(
    input: Omit<TimeseriesHistoryBatchInput, "projectId">
  ): Promise<readonly TimeseriesHistoryBatchResult[]>
  getTelemetryHistory(input: {
    readonly objectTypeId: string
    readonly objectId: string
    readonly propertyId: string
    readonly from?: Date
    readonly to?: Date
    readonly limit?: number
    readonly order?: "asc" | "desc"
  }): Promise<readonly TimeseriesPoint[]>
  getLatestTelemetry(input: {
    readonly objectTypeId: string
    readonly objectId: string
    readonly propertyId: string
  }): Promise<TimeseriesPoint | null>
}

export function createObjectsRuntime<TOntologySources extends readonly OntologySource[]>(
  runtime: SixbRuntimeContext
): ObjectsRuntime<TOntologySources> {
  const objects = Object.assign(
    <TObjectType extends RegisteredObjectType<TOntologySources>>(objectType: TObjectType) => {
      assertObjectTypeRegistered(runtime.ontology.getObjectTypesById(), objectType)
      return createObjectSet<
        TObjectType,
        RegisteredObjectType<TOntologySources>,
        RegisteredValueTypes<TOntologySources>
      >({ ...runtime, objectType }) as ExecutionObjectSet<
        TObjectType,
        RegisteredValueTypes<TOntologySources>,
        RegisteredObjectType<TOntologySources>
      >
    },
    {
      listTypes: () =>
        runtime.ontology.listObjectTypes().filter((objectType) =>
          isAllowed(runtime.authorization, {
            kind: "object.view",
            objectTypeId: objectType.id,
          })
        ),
      getTypeById: (objectTypeId: string) => {
        const objectType = runtime.ontology.getObjectTypeById(objectTypeId)
        return objectType && isAllowed(runtime.authorization, { kind: "object.view", objectTypeId })
          ? objectType
          : null
      },
      resolveType: (objectTypeId: string) => {
        assertAuthorized(runtime, { kind: "object.view", objectTypeId })
        return runtime.ontology.resolveObjectType(objectTypeId)
      },
      getValueTypesById: () => runtime.ontology.getValueTypesById(),
      listSubTypes: (objectTypeId: string) => runtime.ontology.listSubTypes(objectTypeId),
      isValidLinkTarget: (expected: string | string[], actual: string) =>
        runtime.ontology.isValidLinkTarget(expected, actual),
      executeQuery: (input: Omit<ExecuteObjectQueryInput, "projectId">) =>
        executeObjectQuery(
          { projectId: runtime.projectId, ...input },
          {
            ontology: runtime.ontology,
            storage: runtime.storage.objects,
            runtimeAuthorization: runtime.runtimeAuthorization,
            authorization: runtime.authorization,
          }
        ),
      count: (input: Omit<ExecuteObjectCountInput, "projectId">) =>
        countObjects(
          { projectId: runtime.projectId, ...input },
          {
            ontology: runtime.ontology,
            storage: runtime.storage.objects,
            runtimeAuthorization: runtime.runtimeAuthorization,
            authorization: runtime.authorization,
          }
        ),
      exists: (input: Omit<ExecuteObjectExistsInput, "projectId">) =>
        existsObjects(
          { projectId: runtime.projectId, ...input },
          {
            ontology: runtime.ontology,
            storage: runtime.storage.objects,
            runtimeAuthorization: runtime.runtimeAuthorization,
            authorization: runtime.authorization,
          }
        ),
      facet: (input: Omit<ExecuteObjectFacetsInput, "projectId">) =>
        facetObjects(
          { projectId: runtime.projectId, ...input },
          {
            ontology: runtime.ontology,
            storage: runtime.storage.objects,
            runtimeAuthorization: runtime.runtimeAuthorization,
            authorization: runtime.authorization,
          }
        ),
      listLinks: async (input: {
        objectTypeId: string
        objectId: string
        linkId?: string
        direction?: LinkDirection
      }) => {
        assertAuthorized(runtime, { kind: "object.view", objectTypeId: input.objectTypeId })
        const links = await runtime.storage.objects.listLinks({
          projectId: runtime.projectId,
          ...input,
        })
        return links.filter(
          (link) =>
            isAllowed(runtime.authorization, {
              kind: "object.view",
              objectTypeId: link.sourceTypeId,
            }) &&
            isAllowed(runtime.authorization, {
              kind: "object.view",
              objectTypeId: link.targetTypeId,
            })
        )
      },
      getTelemetryHistoryBatch: (input: Omit<TimeseriesHistoryBatchInput, "projectId">) =>
        getTelemetryHistoryBatch(
          { projectId: runtime.projectId, ...input },
          {
            storage: runtime.storage.timeseries,
            runtimeAuthorization: runtime.runtimeAuthorization,
            authorization: runtime.authorization,
          }
        ),
      getTelemetryHistory: (input: {
        objectTypeId: string
        objectId: string
        propertyId: string
        from?: Date
        to?: Date
        limit?: number
        order?: "asc" | "desc"
      }) => {
        assertAuthorized(runtime, { kind: "object.view", objectTypeId: input.objectTypeId })
        return runtime.storage.timeseries.getHistory({
          projectId: runtime.projectId,
          ...input,
        })
      },
      getLatestTelemetry: (input: {
        objectTypeId: string
        objectId: string
        propertyId: string
      }) => {
        assertAuthorized(runtime, { kind: "object.view", objectTypeId: input.objectTypeId })
        return runtime.storage.timeseries.getLatest({
          projectId: runtime.projectId,
          ...input,
        })
      },
      list: (params: ListObjectsParams) => objectService.listObjects(runtime, params),
      get: async (objectTypeId: string, primaryId: string) => {
        assertAuthorized(runtime, { kind: "object.view", objectTypeId })
        return runtime.storage.objects.getByPrimaryId({
          projectId: runtime.projectId,
          objectTypeId,
          primaryId,
        })
      },
      getPrimaryPropertyId: (objectTypeId: string) => {
        assertAuthorized(runtime, { kind: "object.view", objectTypeId })
        return runtime.ontology.getPrimaryPropertyId(objectTypeId)
      },
      upsert: (objectTypeId: string, properties: Record<string, unknown>) =>
        objectService.upsertObject(runtime, objectTypeId, properties),
      upsertBatch: (
        objectTypeId: string,
        items: readonly { properties: Record<string, unknown> }[]
      ) => objectService.upsertObjectBatch(runtime, objectTypeId, items),
      upsertLink: (
        objectTypeId: string,
        sourceId: string,
        linkId: string,
        target: { targetTypeId: string; targetId: string; properties?: Record<string, unknown> }
      ) => objectService.upsertLink(runtime, objectTypeId, sourceId, linkId, target),
      upsertLinkBatch: (
        items: readonly {
          objectTypeId: string
          sourceId: string
          linkId: string
          target: { targetTypeId: string; targetId: string; properties?: Record<string, unknown> }
        }[]
      ) => objectService.upsertLinkBatch(runtime, items),
      removeLink: (
        objectTypeId: string,
        sourceId: string,
        linkId: string,
        target: { targetTypeId: string; targetId: string }
      ) => objectService.removeLink(runtime, objectTypeId, sourceId, linkId, target),
      appendTelemetry: (
        objectTypeId: string,
        items: readonly { id: string; properties: Record<string, unknown>; at?: Date }[]
      ) => objectService.appendTelemetry(runtime, objectTypeId, items),
    }
  )

  return objects as ObjectsRuntime<TOntologySources>
}
