import { shareSixbErrorReporter } from "../error-reporting/capability"
import type { ExecutionContext } from "../execution"
import {
  assertAuthorizedObjectReaderBinding,
  getAuthorizedOntologyView,
} from "../execution/authorized-object-reader"
import type { ValueType } from "../ontology"
import { assertObjectTypeRegistered } from "../ontology"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import { shareOntologyMutationRuntime } from "../runtime/ontology-mutations"
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
import type {
  ExecuteObjectCountInput,
  ExecuteObjectCountResult,
  ExecuteObjectExistsInput,
  ExecuteObjectExistsResult,
  ExecuteObjectFacetsInput,
  ExecuteObjectFacetsResult,
  ExecuteObjectQueryInput,
  ExecuteObjectQueryLinksInput,
  ExecuteObjectQueryLinksResult,
  ExecuteObjectQueryResult,
} from "./query"
import { createObjectSet } from "./sdk"
import type { ListObjectsParams } from "./service"
import * as objectService from "./service"
import { getLatestTelemetryPoint, getTelemetryHistoryBatch } from "./telemetry"

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

/** Public input for querying physical links incident to an object query result. */
export type ObjectQueryLinksInput = Omit<ExecuteObjectQueryLinksInput, "projectId">

/** Public result returned by {@link ObjectsRuntime.queryLinks}. */
export type ObjectQueryLinksResult = ExecuteObjectQueryLinksResult

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
  queryLinks(input: ObjectQueryLinksInput): Promise<ObjectQueryLinksResult>
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
  const runtimeAuthorization = runtime.runtimeAuthorization
  const objectReader = runtime.objectReader
  assertAuthorizedObjectReaderBinding({
    reader: objectReader,
    scope: { execution, authorization: runtimeAuthorization },
  })
  const authorization = runtime.authorization
  const capturedRuntime: SixbRuntimeContext = {
    projectId: runtime.projectId,
    broker: runtime.broker,
    ontology: runtime.ontology,
    actionRegistry: runtime.actionRegistry,
    events: runtime.events,
    storage: runtime.storage,
    queues: runtime.queues,
    runtimeAuthorization,
    objectReader,
    ...(authorization === undefined ? {} : { authorization }),
  }
  shareOntologyMutationRuntime(runtime, capturedRuntime)
  shareSixbErrorReporter(runtime, capturedRuntime)
  Object.freeze(capturedRuntime)
  const ontologyView = () => getAuthorizedOntologyView(objectReader)
  const objects = Object.assign(
    <TObjectType extends RegisteredObjectType<TOntologySources>>(objectType: TObjectType) => {
      assertObjectTypeRegistered(capturedRuntime.ontology.getObjectTypesById(), objectType)
      return createObjectSet<
        TObjectType,
        RegisteredObjectType<TOntologySources>,
        RegisteredValueTypes<TOntologySources>
      >({ ...capturedRuntime, execution, objectType }) as ExecutionObjectSet<
        TObjectType,
        RegisteredValueTypes<TOntologySources>,
        RegisteredObjectType<TOntologySources>
      >
    },
    {
      listTypes: () => ontologyView().listObjectTypes(),
      getTypeById: (objectTypeId: string) => ontologyView().getObjectTypeById(objectTypeId),
      resolveType: (objectTypeId: string) => ontologyView().resolveObjectType(objectTypeId),
      getValueTypesById: () => ontologyView().getValueTypesById(),
      listSubTypes: (objectTypeId: string) => ontologyView().listSubTypes(objectTypeId),
      isValidLinkTarget: (expected: string | string[], actual: string) =>
        ontologyView().isValidLinkTarget(expected, actual),
      executeQuery: (input: Omit<ExecuteObjectQueryInput, "projectId">) =>
        objectReader.executeQuery(input),
      queryLinks: (input: ObjectQueryLinksInput) => objectReader.queryLinks(input),
      count: (input: Omit<ExecuteObjectCountInput, "projectId">) => objectReader.count(input),
      exists: (input: Omit<ExecuteObjectExistsInput, "projectId">) => objectReader.exists(input),
      facet: (input: Omit<ExecuteObjectFacetsInput, "projectId">) => objectReader.facet(input),
      listLinks: async (input: {
        objectTypeId: string
        objectId: string
        linkId?: string
        direction?: LinkDirection
      }) => {
        return objectReader.listLinks(input)
      },
      getTelemetryHistoryBatch: (input: Omit<TimeseriesHistoryBatchInput, "projectId">) => {
        const timeseries = capturedRuntime.storage.timeseries
        return getTelemetryHistoryBatch(input, { storage: timeseries, objectReader })
      },
      getTelemetryHistory: async (input: {
        objectTypeId: string
        objectId: string
        propertyId: string
        from?: Date
        to?: Date
        limit?: number
        order?: "asc" | "desc"
      }) => {
        const timeseries = capturedRuntime.storage.timeseries
        const objectTypeId = input.objectTypeId
        const objectId = input.objectId
        const propertyId = input.propertyId
        const from = input.from
        const to = input.to
        const limit = input.limit
        const order = input.order
        const [result] = await getTelemetryHistoryBatch(
          {
            series: [{ objectTypeId, objectId, propertyId }],
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
            ...(limit === undefined ? {} : { limitPerSeries: limit }),
            ...(order === undefined ? {} : { order }),
          },
          { storage: timeseries, objectReader }
        )
        return result?.points ?? []
      },
      getLatestTelemetry: async (input: {
        objectTypeId: string
        objectId: string
        propertyId: string
      }) => {
        const timeseries = capturedRuntime.storage.timeseries
        const objectTypeId = input.objectTypeId
        const objectId = input.objectId
        const propertyId = input.propertyId
        return getLatestTelemetryPoint(
          { objectTypeId, objectId, propertyId },
          { storage: timeseries, objectReader }
        )
      },
      list: (params: ListObjectsParams) => objectService.listObjects(capturedRuntime, params),
      get: (objectTypeId: string, primaryId: string) =>
        objectReader.getByPrimaryId({ objectTypeId, primaryId }),
      getPrimaryPropertyId: (objectTypeId: string) => {
        return ontologyView().getPrimaryPropertyId(objectTypeId)
      },
      upsert: (objectTypeId: string, properties: Record<string, unknown>) =>
        objectService.upsertObject(capturedRuntime, objectTypeId, properties),
      upsertBatch: (
        objectTypeId: string,
        items: readonly { properties: Record<string, unknown> }[]
      ) => objectService.upsertObjectBatch(capturedRuntime, objectTypeId, items),
      upsertLink: (
        objectTypeId: string,
        sourceId: string,
        linkId: string,
        target: { targetTypeId: string; targetId: string; properties?: Record<string, unknown> }
      ) => objectService.upsertLink(capturedRuntime, objectTypeId, sourceId, linkId, target),
      upsertLinkBatch: (
        items: readonly {
          objectTypeId: string
          sourceId: string
          linkId: string
          target: { targetTypeId: string; targetId: string; properties?: Record<string, unknown> }
        }[]
      ) => objectService.upsertLinkBatch(capturedRuntime, items),
      removeLink: (
        objectTypeId: string,
        sourceId: string,
        linkId: string,
        target: { targetTypeId: string; targetId: string }
      ) => objectService.removeLink(capturedRuntime, objectTypeId, sourceId, linkId, target),
      appendTelemetry: (
        objectTypeId: string,
        items: readonly { id: string; properties: Record<string, unknown>; at?: Date }[]
      ) => objectService.appendTelemetry(capturedRuntime, objectTypeId, items),
    }
  )

  return objects as ObjectsRuntime<TOntologySources>
}
