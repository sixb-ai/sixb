import { assertAuthorized } from "../authorization"
import { assertObjectTypeRegistered } from "../ontology"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import type { ValueType } from "../ontology/types"
import type {
  ListResult,
  ObjectSet,
  OntologySource,
  RegisteredObjectType,
  RegisteredValueTypes,
  SixbHostContext,
  SixbRuntimeContext,
} from "../runtime/types"
import type { ObjectRow } from "../storage"
import { createObjectSet } from "./sdk"
import type { ListObjectsParams } from "./service"
import * as objectService from "./service"

/** Object and value-type definitions owned by the configured host. */
export interface ObjectTypesRuntime {
  listTypes(): readonly ObjectTypeWithPropertyTokens[]
  getTypeById(objectTypeId: string): ObjectTypeWithPropertyTokens | null
  resolveType(objectTypeId: string): ObjectTypeWithPropertyTokens
  getValueTypesById(): ReturnType<SixbHostContext["ontology"]["getValueTypesById"]>
  getPrimaryPropertyId(objectTypeId: string): string
  listSubTypes(objectTypeId: string): string[]
  isValidLinkTarget(expected: string | string[], actual: string): boolean
}

export function createObjectTypesRuntime(context: SixbHostContext): ObjectTypesRuntime {
  return {
    listTypes: () => context.ontology.listObjectTypes(),
    getTypeById: (objectTypeId) => context.ontology.getObjectTypeById(objectTypeId),
    resolveType: (objectTypeId) => context.ontology.resolveObjectType(objectTypeId),
    getValueTypesById: () => context.ontology.getValueTypesById(),
    getPrimaryPropertyId: (objectTypeId) => context.ontology.getPrimaryPropertyId(objectTypeId),
    listSubTypes: (objectTypeId) => context.ontology.listSubTypes(objectTypeId),
    isValidLinkTarget: (expected, actual) => context.ontology.isValidLinkTarget(expected, actual),
  }
}

export interface ObjectsRuntimeOperations {
  listTypes(): readonly ObjectTypeWithPropertyTokens[]
  getTypeById(objectTypeId: string): ObjectTypeWithPropertyTokens | null
  resolveType(objectTypeId: string): ObjectTypeWithPropertyTokens
  getValueTypesById(): ReturnType<SixbHostContext["ontology"]["getValueTypesById"]>
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

/** Object facade used by framework boundaries that do not know an application's ontology. */
export interface DynamicObjectsRuntime extends ObjectsRuntimeOperations {
  <const TObjectType extends ObjectTypeWithPropertyTokens>(
    objectType: TObjectType
  ): ObjectSet<TObjectType, readonly ValueType[], ObjectTypeWithPropertyTokens>
}

/** Object facade specialized to the ontology sources registered by an application. */
export interface ObjectsRuntime<TOntologySources extends readonly OntologySource[]>
  extends ObjectsRuntimeOperations {
  <TObjectType extends RegisteredObjectType<TOntologySources>>(
    objectType: TObjectType
  ): ObjectSet<
    TObjectType,
    RegisteredValueTypes<TOntologySources>,
    RegisteredObjectType<TOntologySources>
  >
}

function composeObjectsRuntime(runtime: SixbRuntimeContext) {
  const objects = (objectType: ObjectTypeWithPropertyTokens) => {
    assertObjectTypeRegistered(runtime.ontology.getObjectTypesById(), objectType)
    return createObjectSet({ ...runtime, objectType })
  }

  return Object.assign(objects, {
    listTypes: () => runtime.ontology.listObjectTypes(),
    getTypeById: (objectTypeId: string) => runtime.ontology.getObjectTypeById(objectTypeId),
    resolveType: (objectTypeId: string) => runtime.ontology.resolveObjectType(objectTypeId),
    getValueTypesById: () => runtime.ontology.getValueTypesById(),
    getPrimaryPropertyId: (objectTypeId: string) =>
      runtime.ontology.getPrimaryPropertyId(objectTypeId),
    listSubTypes: (objectTypeId: string) => runtime.ontology.listSubTypes(objectTypeId),
    isValidLinkTarget: (expected: string | string[], actual: string) =>
      runtime.ontology.isValidLinkTarget(expected, actual),
    get: async (objectTypeId: string, primaryId: string) => {
      assertAuthorized(runtime, { kind: "object.view", objectTypeId })
      return runtime.storage.objects.getByPrimaryId({
        projectId: runtime.projectId,
        objectTypeId,
        primaryId,
      })
    },
    list: (params: ListObjectsParams) => objectService.listObjects(runtime, params),
    upsert: (objectTypeId: string, properties: Record<string, unknown>) =>
      objectService.upsertObject(runtime, objectTypeId, properties),
    upsertBatch: (
      objectTypeId: string,
      items: readonly { properties: Record<string, unknown> }[]
    ) => objectService.upsertObjectBatch(runtime, objectTypeId, items),
    appendTelemetry: (
      objectTypeId: string,
      items: readonly { id: string; properties: Record<string, unknown>; at?: Date }[]
    ) => objectService.appendTelemetry(runtime, objectTypeId, items),
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
  })
}

/** Compose the callable, ontology-specialized object SDK from one runtime context. */
export function createObjectsRuntime<TOntologySources extends readonly OntologySource[]>(
  runtime: SixbRuntimeContext
): ObjectsRuntime<TOntologySources> {
  // Relating the composed callable to an arbitrary registered ontology exceeds TypeScript's
  // instantiation depth. The runtime assertion above enforces the same boundary; keep this one
  // representation conversion inside the factory instead of casting every consumer.
  return composeObjectsRuntime(runtime) as unknown as ObjectsRuntime<TOntologySources>
}

/** Compose the object SDK for framework code that discovers ontology types at runtime. */
export function createDynamicObjectsRuntime(runtime: SixbRuntimeContext): DynamicObjectsRuntime {
  return composeObjectsRuntime(runtime) as unknown as DynamicObjectsRuntime
}
