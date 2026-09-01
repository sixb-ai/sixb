import {
  formatUnknownObjectTypeMessage,
  OntologyNotFoundError,
  OntologyValidationError,
} from "../ontology/errors"
import type { OntologyDefinitionCatalog } from "../ontology/registry"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import { createLinkTokenMap, createPropertyTokenMap } from "../ontology/tokens"
import type {
  ObjectLink,
  ObjectType,
  ObjectTypeSearchMetadata,
  Property,
  PropertyQueryMetadata,
  Schema,
  ValueType,
} from "../ontology/types"
import type { CompiledSelectedObjectReadScope } from "../storage/objects/types"

/** Public ontology operations that may cross an execution-bound authorization boundary. */
export type AuthorizedOntologyView = Pick<
  OntologyDefinitionCatalog,
  | "listObjectTypes"
  | "getObjectTypeById"
  | "resolveObjectType"
  | "getValueTypesById"
  | "getPrimaryPropertyId"
  | "listSubTypes"
  | "isValidLinkTarget"
>

export type AuthorizedOntologySelection =
  | { readonly kind: "all" }
  | { readonly kind: "types"; readonly objectTypeIds: readonly string[] }
  | { readonly kind: "selected"; readonly scope: CompiledSelectedObjectReadScope }

interface LinkSelection {
  readonly targetObjectTypeIds: Set<string>
  readonly propertyIds: Set<string>
}

interface SelectedSchema {
  readonly propertyIdsByObjectType: ReadonlyMap<string, ReadonlySet<string>>
  readonly linksBySourceType: ReadonlyMap<string, ReadonlyMap<string, LinkSelection>>
}

/**
 * Project inert ontology metadata from one already-captured authority.
 *
 * Query validation intentionally keeps using the complete internal registry. This view is only
 * the discovery surface returned to application code and HTTP serializers.
 */
export function createAuthorizedOntologyView(input: {
  readonly ontology: OntologyDefinitionCatalog
  readonly selection: AuthorizedOntologySelection
  readonly assertOutputWithinLimit?: (value: unknown) => void
}): AuthorizedOntologyView {
  const allObjectTypes = input.ontology.listObjectTypes()
  const registeredObjectTypeIds = new Set(allObjectTypes.map((objectType) => objectType.id))
  const requestedObjectTypeIds = selectedObjectTypeIds(input.selection, allObjectTypes)
  const visibleObjectTypeIds = new Set(
    [...requestedObjectTypeIds].filter((objectTypeId) => registeredObjectTypeIds.has(objectTypeId))
  )
  const selectedSchema =
    input.selection.kind === "selected" ? collectSelectedSchema(input.selection.scope) : undefined
  const projectedObjectTypes: ObjectTypeWithPropertyTokens[] = []

  for (const objectType of allObjectTypes) {
    if (!visibleObjectTypeIds.has(objectType.id)) continue
    const propertyIds =
      selectedSchema?.propertyIdsByObjectType.get(objectType.id) ??
      new Set(objectType.properties.map((property) => property.id))
    const links = selectedSchema
      ? (selectedSchema.linksBySourceType.get(objectType.id) ?? new Map())
      : input.selection.kind === "all"
        ? allDeclaredLinks(objectType)
        : allVisibleLinks(input.ontology, objectType, visibleObjectTypeIds)
    projectedObjectTypes.push(
      projectObjectType({
        objectType,
        propertyIds,
        links,
        visibleObjectTypeIds,
        ontology: input.ontology,
        targetMode:
          input.selection.kind === "all"
            ? "original"
            : input.selection.kind === "types"
              ? "principal"
              : "exact",
        exposeContracts: input.selection.kind !== "selected",
      })
    )
  }

  const objectTypes = projectedObjectTypes
  const objectTypesById = new Map(objectTypes.map((objectType) => [objectType.id, objectType]))
  const valueTypesById =
    input.selection.kind === "selected"
      ? collectVisibleValueTypes(input.ontology.getValueTypesById(), objectTypes)
      : snapshotAllValueTypes(input.ontology.getValueTypesById())
  const release = <T>(value: T, budgetValue: unknown = value): T => {
    input.assertOutputWithinLimit?.(budgetValue)
    return value
  }
  const cloneObjectType = (objectType: ObjectTypeWithPropertyTokens) => structuredClone(objectType)
  const cloneValueTypes = () =>
    new Map(
      [...valueTypesById].map(([valueTypeId, valueType]) => [
        valueTypeId,
        structuredClone(valueType),
      ])
    )

  return Object.freeze({
    listObjectTypes: () => release(objectTypes.map(cloneObjectType)),
    getObjectTypeById: (objectTypeId: string) => {
      const objectType = objectTypesById.get(objectTypeId)
      return release(objectType ? cloneObjectType(objectType) : null)
    },
    resolveObjectType: (objectTypeId: string) => {
      const objectType = objectTypesById.get(objectTypeId)
      return objectType ? release(cloneObjectType(objectType)) : unknownObjectType(objectTypeId)
    },
    getValueTypesById: () => {
      const valueTypes = cloneValueTypes()
      return release(valueTypes, [...valueTypes.entries()])
    },
    getPrimaryPropertyId: (objectTypeId: string) => {
      const objectType = objectTypesById.get(objectTypeId)
      if (!objectType) return unknownObjectType(objectTypeId)
      const primary = objectType.properties.find((property) => property.primary)
      if (!primary) {
        throw new OntologyValidationError(
          `[Sixb] Object type '${objectTypeId}' does not expose its primary property in this execution scope.`
        )
      }
      return release(primary.id)
    },
    listSubTypes: (objectTypeId: string) => {
      const subTypes = visibleObjectTypeIds.has(objectTypeId)
        ? input.ontology
            .listSubTypes(objectTypeId)
            .filter((subTypeId) => visibleObjectTypeIds.has(subTypeId))
        : []
      return release(subTypes)
    },
    isValidLinkTarget: (expected: string | string[], actual: string) => {
      if (input.selection.kind === "all") {
        return release(input.ontology.isValidLinkTarget(expected, actual))
      }
      if (!visibleObjectTypeIds.has(actual)) return release(false)
      const expectedTypes = Array.isArray(expected) ? expected : [expected]
      if (input.selection.kind === "selected") {
        return release(
          expectedTypes.some((expectedType) => expectedType === "*" || expectedType === actual)
        )
      }
      return release(
        expectedTypes.some(
          (expectedType) =>
            expectedType === "*" ||
            (visibleObjectTypeIds.has(expectedType) &&
              input.ontology.isValidLinkTarget(expectedType, actual))
        )
      )
    },
  })
}

function selectedObjectTypeIds(
  selection: AuthorizedOntologySelection,
  allObjectTypes: readonly ObjectTypeWithPropertyTokens[]
): ReadonlySet<string> {
  switch (selection.kind) {
    case "all":
      return new Set(allObjectTypes.map((objectType) => objectType.id))
    case "types":
      return new Set(selection.objectTypeIds)
    case "selected":
      return new Set(selection.scope.objects.map((object) => object.objectTypeId))
  }
}

function collectSelectedSchema(scope: CompiledSelectedObjectReadScope): SelectedSchema {
  const propertyIdsByObjectType = new Map<string, Set<string>>()
  for (const object of scope.objects) {
    const properties = propertyIdsByObjectType.get(object.objectTypeId) ?? new Set<string>()
    for (const propertyId of object.propertyIds) properties.add(propertyId)
    propertyIdsByObjectType.set(object.objectTypeId, properties)
  }

  const linksBySourceType = new Map<string, Map<string, LinkSelection>>()
  for (const step of scope.steps) {
    const links = linksBySourceType.get(step.sourceObjectTypeId) ?? new Map()
    const selected = links.get(step.linkId) ?? {
      targetObjectTypeIds: new Set<string>(),
      propertyIds: new Set<string>(),
    }
    selected.targetObjectTypeIds.add(step.targetObjectTypeId)
    for (const propertyId of step.propertyIds) selected.propertyIds.add(propertyId)
    links.set(step.linkId, selected)
    linksBySourceType.set(step.sourceObjectTypeId, links)
  }

  return { propertyIdsByObjectType, linksBySourceType }
}

function allDeclaredLinks(
  objectType: ObjectTypeWithPropertyTokens
): ReadonlyMap<string, LinkSelection> {
  return new Map(
    objectType.links.map((link) => [
      link.id,
      {
        targetObjectTypeIds: new Set(
          typeof link.targetObjectTypeId === "string"
            ? [link.targetObjectTypeId]
            : link.targetObjectTypeId
        ),
        propertyIds: new Set(link.properties?.map((property) => property.id) ?? []),
      },
    ])
  )
}

function allVisibleLinks(
  ontology: OntologyDefinitionCatalog,
  objectType: ObjectTypeWithPropertyTokens,
  visibleObjectTypeIds: ReadonlySet<string>
): ReadonlyMap<string, LinkSelection> {
  const links = new Map<string, LinkSelection>()
  for (const link of objectType.links) {
    const targetObjectTypeIds = new Set(
      [...visibleObjectTypeIds].filter((targetObjectTypeId) =>
        ontology.isValidLinkTarget(link.targetObjectTypeId, targetObjectTypeId)
      )
    )
    if (targetObjectTypeIds.size === 0) continue
    links.set(link.id, {
      targetObjectTypeIds,
      propertyIds: new Set(link.properties?.map((property) => property.id) ?? []),
    })
  }
  return links
}

function projectObjectType(input: {
  readonly ontology: OntologyDefinitionCatalog
  readonly objectType: ObjectTypeWithPropertyTokens
  readonly propertyIds: ReadonlySet<string>
  readonly links: ReadonlyMap<string, LinkSelection>
  readonly visibleObjectTypeIds: ReadonlySet<string>
  readonly targetMode: "original" | "principal" | "exact"
  readonly exposeContracts: boolean
}): ObjectTypeWithPropertyTokens {
  const properties = input.objectType.properties
    .filter((property) => input.propertyIds.has(property.id))
    .map(snapshotProperty)
  const visiblePropertyIds = new Set(properties.map((property) => property.id))
  const links = input.objectType.links.flatMap((link): ObjectLink[] => {
    const selected = input.links.get(link.id)
    if (!selected) return []
    if (input.targetMode === "original") {
      return [snapshotLink(link, snapshotLinkTarget(link.targetObjectTypeId), selected.propertyIds)]
    }
    const targetObjectTypeIds = new Set(
      [...selected.targetObjectTypeIds].filter(
        (targetObjectTypeId) =>
          input.visibleObjectTypeIds.has(targetObjectTypeId) &&
          input.ontology.isValidLinkTarget(link.targetObjectTypeId, targetObjectTypeId)
      )
    )
    if (targetObjectTypeIds.size === 0) return []
    const target =
      input.targetMode === "principal"
        ? principalLinkTargets(link, targetObjectTypeIds, input.visibleObjectTypeIds)
        : exactLinkTargets(targetObjectTypeIds)
    return [snapshotLink(link, target, selected.propertyIds, { omitEmptyProperties: true })]
  })

  // Whitelist top-level metadata so future cross-ontology fields remain closed until reviewed.
  const projected: ObjectType = {
    id: input.objectType.id,
    name: input.objectType.name,
    description: input.objectType.description,
    quantityKind: input.objectType.quantityKind,
    seeAlso: input.objectType.seeAlso ? [...input.objectType.seeAlso] : undefined,
    extends:
      input.objectType.extends && input.visibleObjectTypeIds.has(input.objectType.extends)
        ? input.objectType.extends
        : undefined,
    parents: projectOptionalIds(
      input.objectType.parents,
      input.visibleObjectTypeIds,
      input.targetMode === "original"
    ),
    implements:
      input.exposeContracts && input.objectType.implements
        ? [...input.objectType.implements]
        : undefined,
    properties,
    links,
    search: projectSearch(input.objectType.search, visiblePropertyIds, {
      preserveEmpty: input.targetMode !== "exact",
    }),
  }
  const withTokens = {
    ...projected,
    p: createPropertyTokenMap(projected),
    l: createLinkTokenMap(projected),
  }
  return deepFreeze(withTokens) as ObjectTypeWithPropertyTokens
}

function principalLinkTargets(
  link: ObjectLink,
  allowedTargetObjectTypeIds: ReadonlySet<string>,
  visibleObjectTypeIds: ReadonlySet<string>
): string | string[] {
  if (link.targetObjectTypeId === "*") return exactLinkTargets(allowedTargetObjectTypeIds)
  const declared = Array.isArray(link.targetObjectTypeId)
    ? link.targetObjectTypeId
    : [link.targetObjectTypeId]
  if (declared.every((objectTypeId) => visibleObjectTypeIds.has(objectTypeId))) {
    return snapshotLinkTarget(link.targetObjectTypeId)
  }
  return exactLinkTargets(allowedTargetObjectTypeIds)
}

function exactLinkTargets(targetObjectTypeIds: ReadonlySet<string>): string | string[] {
  const targets = [...targetObjectTypeIds].sort()
  return targets.length === 1 ? targets[0]! : targets
}

function projectOptionalIds(
  ids: readonly string[] | undefined,
  visibleObjectTypeIds: ReadonlySet<string>,
  preserveOriginal: boolean
): string[] | undefined {
  if (!ids) return undefined
  if (preserveOriginal) return [...ids]
  const visible = ids.filter((id) => visibleObjectTypeIds.has(id))
  return visible.length > 0 ? visible : undefined
}

function snapshotLink(
  link: ObjectLink,
  targetObjectTypeId: string | string[],
  propertyIds: ReadonlySet<string>,
  options: { readonly omitEmptyProperties?: boolean } = {}
): ObjectLink {
  const properties = link.properties
    ?.filter((property) => propertyIds.has(property.id))
    .map(snapshotProperty)
  return {
    id: link.id,
    name: link.name,
    description: link.description,
    targetObjectTypeId,
    cardinality: link.cardinality,
    properties: options.omitEmptyProperties && properties?.length === 0 ? undefined : properties,
  }
}

function snapshotLinkTarget(target: string | readonly string[]): string | string[] {
  return typeof target === "string" ? target : [...target]
}

function snapshotProperty(property: Property): Property {
  return {
    id: property.id,
    name: property.name,
    schema: snapshotSchema(property.schema),
    description: property.description,
    required: property.required,
    nullable: property.nullable,
    primary: property.primary,
    mode: property.mode,
    semanticType: property.semanticType,
    query: snapshotPropertyQuery(property.query),
  }
}

function snapshotPropertyQuery(
  query: PropertyQueryMetadata | undefined
): PropertyQueryMetadata | undefined {
  if (!query) return undefined
  return {
    searchable: query.searchable,
    filterable: query.filterable,
    sortable: query.sortable,
    text: query.text,
    exact: query.exact,
    facet: query.facet,
    vector: query.vector,
    weight: query.weight,
  }
}

function projectSearch(
  search: ObjectTypeSearchMetadata | undefined,
  visiblePropertyIds: ReadonlySet<string>,
  options: { readonly preserveEmpty: boolean }
): ObjectTypeSearchMetadata | undefined {
  if (!search) return undefined
  const title = search.title && visiblePropertyIds.has(search.title) ? search.title : undefined
  const selectedDefaultText = search.defaultText?.filter((propertyId) =>
    visiblePropertyIds.has(propertyId)
  )
  const selectedExact = search.exact?.filter((propertyId) => visiblePropertyIds.has(propertyId))
  const defaultText =
    options.preserveEmpty || selectedDefaultText?.length ? selectedDefaultText : undefined
  const exact = options.preserveEmpty || selectedExact?.length ? selectedExact : undefined
  const vector =
    search.vector &&
    visiblePropertyIds.has(search.vector.property) &&
    search.vector.source.every((propertyId) => visiblePropertyIds.has(propertyId))
      ? { property: search.vector.property, source: [...search.vector.source] }
      : undefined
  const projected: ObjectTypeSearchMetadata = {
    ...(title === undefined ? {} : { title }),
    ...(defaultText === undefined ? {} : { defaultText }),
    ...(exact === undefined ? {} : { exact }),
    ...(vector === undefined ? {} : { vector }),
  }
  return Object.keys(projected).length > 0 || options.preserveEmpty ? projected : undefined
}

function snapshotAllValueTypes(
  registered: ReadonlyMap<string, ValueType>
): ReadonlyMap<string, ValueType> {
  return new Map(
    [...registered.values()].map((valueType) => {
      const snapshot = snapshotValueType(valueType)
      return [snapshot.id, snapshot] as const
    })
  )
}

function collectVisibleValueTypes(
  registered: ReadonlyMap<string, ValueType>,
  objectTypes: readonly ObjectTypeWithPropertyTokens[]
): ReadonlyMap<string, ValueType> {
  const referencedIds = new Set<string>()
  const pendingSchemas: Schema[] = []
  const visitedSchemas = new Set<object>()
  for (const objectType of objectTypes) {
    for (const property of objectType.properties) pendingSchemas.push(property.schema)
    for (const link of objectType.links) {
      for (const property of link.properties ?? []) pendingSchemas.push(property.schema)
    }
  }

  while (pendingSchemas.length > 0) {
    const schema = pendingSchemas.pop()!
    if (typeof schema === "string" || visitedSchemas.has(schema)) continue
    visitedSchemas.add(schema)
    if (schema.type === "valueTypeRef") {
      if (!referencedIds.has(schema.valueTypeId)) {
        referencedIds.add(schema.valueTypeId)
        const valueType = registered.get(schema.valueTypeId)
        if (valueType) pendingSchemas.push(valueType.schema)
      }
      if (schema._resolved) pendingSchemas.push(schema._resolved)
    } else if (schema.type === "object") {
      for (const field of Object.values(schema.properties)) pendingSchemas.push(field.schema)
    } else if (schema.type === "array") {
      pendingSchemas.push(schema.items)
    } else if (schema.type === "map") {
      pendingSchemas.push(schema.valueSchema)
    }
  }

  return new Map(
    [...referencedIds]
      .map((valueTypeId) => registered.get(valueTypeId))
      .filter((valueType): valueType is ValueType => valueType !== undefined)
      .map((valueType) => {
        const snapshot = snapshotValueType(valueType)
        return [snapshot.id, snapshot] as const
      })
  )
}

function snapshotValueType(valueType: ValueType): ValueType {
  return deepFreeze({
    id: valueType.id,
    name: valueType.name,
    description: valueType.description,
    schema: snapshotSchema(valueType.schema),
    semanticType: valueType.semanticType,
  })
}

function snapshotSchema(schema: Schema): Schema {
  return deepFreeze(structuredClone(schema))
}

function deepFreeze<T>(value: T, seen: Set<object> = new Set()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen)
  }
  return Object.freeze(value)
}

function unknownObjectType(objectTypeId: string): never {
  throw new OntologyNotFoundError(formatUnknownObjectTypeMessage(objectTypeId))
}
