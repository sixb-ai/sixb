import { assertAuthorized } from "../authorization"
import type { ExecutionContext } from "../execution"
import { resolveExecutionScopeAuthorization } from "../execution/authorization"
import { assertAuthorizedObjectReaderBinding } from "../execution/authorized-object-reader"
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
import { createExposedOntologyCatalog } from "./ontology-catalog"
import type {
  ExecuteObjectCountInput,
  ExecuteObjectCountResult,
  ExecuteObjectExistsInput,
  ExecuteObjectExistsResult,
  ExecuteObjectFacetsInput,
  ExecuteObjectFacetsResult,
  ExecuteObjectQueryInput,
  ExecuteObjectQueryResult,
} from "./query"
import { createObjectSet } from "./sdk"
import type { ListObjectsParams } from "./service"
import * as objectService from "./service"
import { getLatestTelemetryPoint, getTelemetryHistoryBatch } from "./telemetry/history"

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
  upsertByPrimaryId(
    objectTypeId: string,
    primaryId: string,
    properties: Record<string, unknown>
  ): Promise<ObjectRow>
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
  runtime: SixbRuntimeContext,
  execution: ExecutionContext
): ObjectsRuntime<TOntologySources> {
  let ontologyCatalog: ReturnType<typeof createExposedOntologyCatalog> | undefined
  const getOntologyCatalog = (): ReturnType<typeof createExposedOntologyCatalog> => {
    ontologyCatalog ??= createExposedOntologyCatalog(runtime, execution)
    return ontologyCatalog
  }
  let executionAuthority: ReturnType<typeof resolveExecutionScopeAuthorization> | undefined
  const getExecutionAuthority = (): ReturnType<typeof resolveExecutionScopeAuthorization> => {
    executionAuthority ??= resolveExecutionScopeAuthorization(runtime.projectId, {
      authorization: runtime.runtimeAuthorization,
      execution,
    })
    return executionAuthority
  }
  getExecutionAuthority()
  assertAuthorizedObjectReaderBinding({
    reader: runtime.objectReader,
    scope: { execution, authorization: runtime.runtimeAuthorization },
  })
  const objects = Object.assign(
    <TObjectType extends RegisteredObjectType<TOntologySources>>(objectType: TObjectType) => {
      assertObjectTypeRegistered(runtime.ontology.getObjectTypesById(), objectType)
      return createObjectSet<
        TObjectType,
        RegisteredObjectType<TOntologySources>,
        RegisteredValueTypes<TOntologySources>
      >({ ...runtime, execution, objectType }) as ExecutionObjectSet<
        TObjectType,
        RegisteredValueTypes<TOntologySources>,
        RegisteredObjectType<TOntologySources>
      >
    },
    {
      listTypes: () => getOntologyCatalog().listObjectTypes(),
      getTypeById: (objectTypeId: string) => getOntologyCatalog().getObjectTypeById(objectTypeId),
      resolveType: (objectTypeId: string) => getOntologyCatalog().resolveObjectType(objectTypeId),
      getValueTypesById: () => getOntologyCatalog().getValueTypesById(),
      listSubTypes: (objectTypeId: string) => getOntologyCatalog().listSubTypes(objectTypeId),
      isValidLinkTarget: (expected: string | string[], actual: string) =>
        getOntologyCatalog().isValidLinkTarget(expected, actual),
      executeQuery: (input: Omit<ExecuteObjectQueryInput, "projectId">) =>
        runtime.objectReader.executeQuery(input),
      count: (input: Omit<ExecuteObjectCountInput, "projectId">) =>
        runtime.objectReader.count(input),
      exists: (input: Omit<ExecuteObjectExistsInput, "projectId">) =>
        runtime.objectReader.exists(input),
      facet: (input: Omit<ExecuteObjectFacetsInput, "projectId">) =>
        runtime.objectReader.facet(input),
      listLinks: async (input: {
        objectTypeId: string
        objectId: string
        linkId?: string
        direction?: LinkDirection
      }) => {
        assertAuthorized(runtime, { kind: "object.view", objectTypeId: input.objectTypeId })
        return runtime.objectReader.listLinks({
          ...input,
        })
      },
      getTelemetryHistoryBatch: (input: Omit<TimeseriesHistoryBatchInput, "projectId">) =>
        getTelemetryHistoryBatch(
          {
            series: input.series,
            ...(input.from === undefined ? {} : { from: input.from }),
            ...(input.to === undefined ? {} : { to: input.to }),
            ...(input.limitPerSeries === undefined ? {} : { limitPerSeries: input.limitPerSeries }),
            ...(input.order === undefined ? {} : { order: input.order }),
          },
          {
            storage: runtime.storage.timeseries,
            objectReader: runtime.objectReader,
          }
        ),
      getTelemetryHistory: async (input: {
        objectTypeId: string
        objectId: string
        propertyId: string
        from?: Date
        to?: Date
        limit?: number
        order?: "asc" | "desc"
      }) => {
        const [result] = await getTelemetryHistoryBatch(
          {
            series: [
              {
                objectTypeId: input.objectTypeId,
                objectId: input.objectId,
                propertyId: input.propertyId,
              },
            ],
            ...(input.from === undefined ? {} : { from: input.from }),
            ...(input.to === undefined ? {} : { to: input.to }),
            ...(input.limit === undefined ? {} : { limitPerSeries: input.limit }),
            ...(input.order === undefined ? {} : { order: input.order }),
          },
          { storage: runtime.storage.timeseries, objectReader: runtime.objectReader }
        )
        return result?.points ?? []
      },
      getLatestTelemetry: async (input: {
        objectTypeId: string
        objectId: string
        propertyId: string
      }) => {
        return getLatestTelemetryPoint(input, {
          storage: runtime.storage.timeseries,
          objectReader: runtime.objectReader,
        })
      },
      list: (params: ListObjectsParams) => objectService.listObjects(runtime, params),
      get: async (objectTypeId: string, primaryId: string) => {
        assertAuthorized(runtime, { kind: "object.view", objectTypeId })
        return runtime.objectReader.getByPrimaryId({
          objectTypeId,
          primaryId,
        })
      },
      getPrimaryPropertyId: (objectTypeId: string) => {
        return getOntologyCatalog().getPrimaryPropertyId(objectTypeId)
      },
      upsert: (objectTypeId: string, properties: Record<string, unknown>) =>
        objectService.upsertObject(runtime, objectTypeId, properties),
      upsertByPrimaryId: (
        objectTypeId: string,
        primaryId: string,
        properties: Record<string, unknown>
      ) => objectService.upsertObjectByPrimaryId(runtime, objectTypeId, primaryId, properties),
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
