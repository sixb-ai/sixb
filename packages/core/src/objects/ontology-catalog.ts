import { type AuthorizationContext, isAllowed, type RuntimeAccessPlan } from "../authorization"
import { objectReadScopeForAccessPlan } from "../authorization/access-plan"
import {
  resolveExecutionScopeAuthorization,
  resolveRuntimeAuthorizationForProject,
} from "../execution/authorization"
import type { ExecutionContext, RuntimeAuthorization } from "../execution/types"
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
import { compileObjectReadScope } from "../storage/objects/read-scope"

type ExposedOntologyCatalog = Pick<
  OntologyDefinitionCatalog,
  | "listObjectTypes"
  | "getObjectTypeById"
  | "resolveObjectType"
  | "getValueTypesById"
  | "getPrimaryPropertyId"
  | "listSubTypes"
  | "isValidLinkTarget"
>

interface ProjectedLinkSelection {
  readonly targetObjectTypeIds: Set<string>
  readonly propertyIds: Set<string>
}

interface DelegatedSchemaSelection {
  readonly propertyIdsByObjectType: ReadonlyMap<string, ReadonlySet<string>>
  readonly linksBySourceType: ReadonlyMap<string, ReadonlyMap<string, ProjectedLinkSelection>>
}

interface ExposedOntologyRuntime {
  readonly projectId: string
  readonly runtimeAuthorization?: RuntimeAuthorization
  readonly ontology: OntologyDefinitionCatalog
}

/** Read-only Map semantics with no mutable handle hidden behind the TypeScript interface. */
class ImmutableReadonlyMap<TKey, TValue> implements ReadonlyMap<TKey, TValue> {
  readonly #values: Map<TKey, TValue>
  readonly [Symbol.toStringTag] = "Map"

  constructor(entries: Iterable<readonly [TKey, TValue]> = []) {
    this.#values = new Map(entries)
    Object.freeze(this)
  }

  get size(): number {
    return this.#values.size
  }

  get(key: TKey): TValue | undefined {
    return this.#values.get(key)
  }

  has(key: TKey): boolean {
    return this.#values.has(key)
  }

  entries(): ReturnType<Map<TKey, TValue>["entries"]> {
    return this.#values.entries()
  }

  keys(): ReturnType<Map<TKey, TValue>["keys"]> {
    return this.#values.keys()
  }

  values(): ReturnType<Map<TKey, TValue>["values"]> {
    return this.#values.values()
  }

  [Symbol.iterator](): ReturnType<Map<TKey, TValue>[typeof Symbol.iterator]> {
    return this.#values[Symbol.iterator]()
  }

  forEach(
    callback: (value: TValue, key: TKey, map: ReadonlyMap<TKey, TValue>) => void,
    thisArg?: unknown
  ): void {
    for (const [key, value] of this.#values) callback.call(thisArg, value, key, this)
  }

  set(_key: TKey, _value: TValue): never {
    throw immutableCatalogMutation()
  }

  delete(_key: TKey): never {
    throw immutableCatalogMutation()
  }

  clear(): never {
    throw immutableCatalogMutation()
  }
}

Object.freeze(ImmutableReadonlyMap.prototype)

/**
 * Build the ontology view exposed by one bound runtime.
 *
 * Query validation deliberately keeps using the host registry. This catalog is only the public
 * schema surface, so delegated snapshots cannot be widened by definitions added after issuance.
 */
export function createExposedOntologyCatalog(
  runtime: ExposedOntologyRuntime,
  execution: ExecutionContext
): ExposedOntologyCatalog {
  const projectAuthority = resolveRuntimeAuthorizationForProject(runtime)

  // Resolve authority before touching the ontology registry. An unbound or cross-project runtime
  // must not be able to use catalog behavior as an ontology-existence oracle.
  if (projectAuthority.type === "denied" || runtime.runtimeAuthorization === undefined) {
    return EMPTY_ONTOLOGY_CATALOG
  }
  const authority = resolveExecutionScopeAuthorization(runtime.projectId, {
    authorization: runtime.runtimeAuthorization,
    execution,
  })
  if (authority.type === "unrestricted") return projectUnrestrictedCatalog(runtime.ontology)

  if (authority.type === "principal") {
    return projectPrincipalCatalog(runtime.ontology, authority.context)
  }
  return projectDelegatedCatalog(runtime.ontology, authority.access)
}

const EMPTY_VALUE_TYPES: ReadonlyMap<string, ValueType> = new ImmutableReadonlyMap()

const EMPTY_ONTOLOGY_CATALOG: ExposedOntologyCatalog = Object.freeze({
  listObjectTypes: () => [],
  getObjectTypeById: () => null,
  resolveObjectType: (objectTypeId: string) => unknownObjectType(objectTypeId),
  getValueTypesById: () => EMPTY_VALUE_TYPES,
  getPrimaryPropertyId: (objectTypeId: string) => unknownObjectType(objectTypeId),
  listSubTypes: () => [],
  isValidLinkTarget: () => false,
})

function projectUnrestrictedCatalog(ontology: OntologyDefinitionCatalog): ExposedOntologyCatalog {
  const allObjectTypes = ontology.listObjectTypes()
  const visibleObjectTypeIds = new Set(allObjectTypes.map((objectType) => objectType.id))
  const projected = allObjectTypes.map((objectType) =>
    projectObjectType({
      objectType,
      propertyIds: new Set(objectType.properties.map((property) => property.id)),
      links: new Map(
        objectType.links.map((link) => [
          link.id,
          {
            targetObjectTypeIds: new Set(
              link.targetObjectTypeId === "*"
                ? visibleObjectTypeIds
                : Array.isArray(link.targetObjectTypeId)
                  ? link.targetObjectTypeId
                  : [link.targetObjectTypeId]
            ),
            propertyIds: new Set(link.properties?.map((property) => property.id) ?? []),
          },
        ])
      ),
      visibleObjectTypeIds,
      linkTargetMode: "original",
      exposeContracts: true,
    })
  )
  return createProjectedCatalog(ontology, projected, { includeAllValueTypes: true })
}

function projectPrincipalCatalog(
  ontology: OntologyDefinitionCatalog,
  authorization: AuthorizationContext
): ExposedOntologyCatalog {
  const allObjectTypes = ontology.listObjectTypes()
  // Broad selectors and subtype inheritance are expanded to concrete ids by resolveRoleGrants.
  // Still route membership through the same evaluator as protected leaves so catalog visibility
  // cannot drift if principal grant semantics change later.
  const visibleObjectTypeIds = new Set(
    allObjectTypes
      .filter((objectType) =>
        isAllowed(authorization, { kind: "object.view", objectTypeId: objectType.id })
      )
      .map((objectType) => objectType.id)
  )
  const allObjectTypeIds = new Set(allObjectTypes.map((objectType) => objectType.id))
  const projected = allObjectTypes
    .filter((objectType) => visibleObjectTypeIds.has(objectType.id))
    .map((objectType) =>
      projectObjectType({
        objectType,
        propertyIds: new Set(objectType.properties.map((property) => property.id)),
        links: new Map(
          objectType.links.flatMap((link) => {
            const targetObjectTypeIds = new Set(
              [...visibleObjectTypeIds].filter(
                (targetObjectTypeId) =>
                  allObjectTypeIds.has(targetObjectTypeId) &&
                  ontology.isValidLinkTarget(link.targetObjectTypeId, targetObjectTypeId)
              )
            )
            return targetObjectTypeIds.size === 0
              ? []
              : [
                  [
                    link.id,
                    {
                      targetObjectTypeIds,
                      propertyIds: new Set(link.properties?.map((property) => property.id) ?? []),
                    },
                  ] as const,
                ]
          })
        ),
        visibleObjectTypeIds,
        linkTargetMode: "principal",
        exposeContracts: true,
      })
    )

  return createProjectedCatalog(ontology, projected)
}

function projectDelegatedCatalog(
  ontology: OntologyDefinitionCatalog,
  access: RuntimeAccessPlan
): ExposedOntologyCatalog {
  const selection = collectDelegatedSchemaSelection(access)
  const visibleObjectTypeIds = new Set(selection.propertyIdsByObjectType.keys())
  const projected: ObjectTypeWithPropertyTokens[] = []

  // Follow registry order for deterministic list responses, but never infer a schema member from
  // that registry iteration: every property, link, edge property, and target comes from the plan.
  for (const objectType of ontology.listObjectTypes()) {
    const propertyIds = selection.propertyIdsByObjectType.get(objectType.id)
    if (!propertyIds) continue

    const snapshottedLinks = selection.linksBySourceType.get(objectType.id)
    const currentLinks = new Map(objectType.links.map((link) => [link.id, link]))
    const links = new Map<string, ProjectedLinkSelection>()
    for (const [linkId, selectedLink] of snapshottedLinks ?? []) {
      const currentLink = currentLinks.get(linkId)
      if (!currentLink) continue

      const targetObjectTypeIds = new Set(
        [...selectedLink.targetObjectTypeIds].filter(
          (targetObjectTypeId) =>
            visibleObjectTypeIds.has(targetObjectTypeId) &&
            ontology.isValidLinkTarget(currentLink.targetObjectTypeId, targetObjectTypeId)
        )
      )
      if (targetObjectTypeIds.size === 0) continue

      const currentPropertyIds = new Set(
        currentLink.properties?.map((property) => property.id) ?? []
      )
      links.set(linkId, {
        targetObjectTypeIds,
        propertyIds: new Set(
          [...selectedLink.propertyIds].filter((propertyId) => currentPropertyIds.has(propertyId))
        ),
      })
    }

    projected.push(
      projectObjectType({
        objectType,
        propertyIds,
        links,
        visibleObjectTypeIds,
        linkTargetMode: "exact",
        exposeContracts: false,
      })
    )
  }

  return createProjectedCatalog(ontology, projected)
}

function collectDelegatedSchemaSelection(access: RuntimeAccessPlan): DelegatedSchemaSelection {
  const compiled = compileObjectReadScope(objectReadScopeForAccessPlan(access))
  if (compiled.kind === "all") {
    // RuntimeAccessPlan can only compile selected roots. Keep this exhaustive guard fail closed if
    // the storage scope model ever grows another source of authority.
    return { propertyIdsByObjectType: new Map(), linksBySourceType: new Map() }
  }

  const propertyIdsByObjectType = new Map<string, Set<string>>()
  for (const object of compiled.objects) {
    const properties = propertyIdsByObjectType.get(object.objectTypeId) ?? new Set<string>()
    for (const propertyId of object.propertyIds) properties.add(propertyId)
    propertyIdsByObjectType.set(object.objectTypeId, properties)
  }

  const linksBySourceType = new Map<string, Map<string, ProjectedLinkSelection>>()
  for (const step of compiled.steps) {
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

function projectObjectType(input: {
  readonly objectType: ObjectTypeWithPropertyTokens
  readonly propertyIds: ReadonlySet<string>
  readonly links: ReadonlyMap<string, ProjectedLinkSelection>
  readonly visibleObjectTypeIds: ReadonlySet<string>
  readonly linkTargetMode: "original" | "principal" | "exact"
  readonly exposeContracts: boolean
}): ObjectTypeWithPropertyTokens {
  const properties = input.objectType.properties
    .filter((property) => input.propertyIds.has(property.id))
    .map(snapshotProperty)
  const visiblePropertyIds = new Set(properties.map((property) => property.id))
  const links = input.objectType.links.flatMap((link): ObjectLink[] => {
    const selected = input.links.get(link.id)
    if (!selected || selected.targetObjectTypeIds.size === 0) return []
    const selectedPropertyIds = selected.propertyIds
    const targetObjectTypeId =
      input.linkTargetMode === "original"
        ? snapshotLinkTarget(link.targetObjectTypeId)
        : input.linkTargetMode === "principal"
          ? principalLinkTargets(link, selected.targetObjectTypeIds, input.visibleObjectTypeIds)
          : exactLinkTargets(selected.targetObjectTypeIds)
    return [snapshotLink(link, targetObjectTypeId, selectedPropertyIds)]
  })

  // Whitelist public fields instead of spreading the source. New schema metadata must be reviewed
  // before it crosses this security boundary; optional fields added later therefore fail closed.
  const projected: ObjectType = {
    id: input.objectType.id,
    name: input.objectType.name,
    description: input.objectType.description,
    quantityKind: input.objectType.quantityKind,
    seeAlso: input.objectType.seeAlso ? frozenArray(input.objectType.seeAlso) : undefined,
    extends:
      input.objectType.extends && input.visibleObjectTypeIds.has(input.objectType.extends)
        ? input.objectType.extends
        : undefined,
    parents: input.objectType.parents
      ? frozenArray(
          input.objectType.parents.filter((parentId) => input.visibleObjectTypeIds.has(parentId))
        )
      : undefined,
    implements:
      input.exposeContracts && input.objectType.implements
        ? frozenArray(input.objectType.implements)
        : undefined,
    properties: frozenArray(properties),
    links: frozenArray(links),
    search: projectSearch(input.objectType.search, visiblePropertyIds),
  }

  const p = createPropertyTokenMap(projected)
  const l = createLinkTokenMap(projected)
  for (const token of Object.values(p)) Object.freeze(token)
  for (const token of Object.values(l)) Object.freeze(token)
  return Object.freeze({
    ...projected,
    p: Object.freeze(p),
    l: Object.freeze(l),
  }) as ObjectTypeWithPropertyTokens
}

function principalLinkTargets(
  link: ObjectLink,
  allowedTargetObjectTypeIds: ReadonlySet<string>,
  visibleObjectTypeIds: ReadonlySet<string>
): string | string[] {
  if (link.targetObjectTypeId === "*") {
    // A wildcard is global ontology authority. Returning it from a projected catalog would let a
    // client infer that unlisted types remain valid targets, so make its visible targets concrete.
    return exactLinkTargets(allowedTargetObjectTypeIds)
  }

  const declared = Array.isArray(link.targetObjectTypeId)
    ? link.targetObjectTypeId
    : [link.targetObjectTypeId]
  if (declared.every((objectTypeId) => visibleObjectTypeIds.has(objectTypeId))) {
    return Array.isArray(link.targetObjectTypeId)
      ? [...link.targetObjectTypeId]
      : link.targetObjectTypeId
  }
  return exactLinkTargets(allowedTargetObjectTypeIds)
}

function exactLinkTargets(targetObjectTypeIds: ReadonlySet<string>): string | string[] {
  const targets = [...targetObjectTypeIds].sort()
  return targets.length === 1 ? targets[0]! : targets
}

function projectSearch(
  search: ObjectTypeSearchMetadata | undefined,
  visiblePropertyIds: ReadonlySet<string>
): ObjectTypeSearchMetadata | undefined {
  if (!search) return undefined
  const title = search.title && visiblePropertyIds.has(search.title) ? search.title : undefined
  const defaultText = search.defaultText?.filter((propertyId) => visiblePropertyIds.has(propertyId))
  const exact = search.exact?.filter((propertyId) => visiblePropertyIds.has(propertyId))
  const vector =
    search.vector &&
    visiblePropertyIds.has(search.vector.property) &&
    search.vector.source.every((propertyId) => visiblePropertyIds.has(propertyId))
      ? {
          property: search.vector.property,
          source: frozenArray(search.vector.source),
        }
      : undefined
  return Object.freeze({
    ...(title === undefined ? {} : { title }),
    ...(defaultText === undefined ? {} : { defaultText: frozenArray(defaultText) }),
    ...(exact === undefined ? {} : { exact: frozenArray(exact) }),
    ...(vector === undefined ? {} : { vector: Object.freeze(vector) }),
  })
}

function createProjectedCatalog(
  ontology: OntologyDefinitionCatalog,
  objectTypes: readonly ObjectTypeWithPropertyTokens[],
  options: { readonly includeAllValueTypes?: boolean } = {}
): ExposedOntologyCatalog {
  const objectTypesById = new Map(objectTypes.map((objectType) => [objectType.id, objectType]))
  const visibleObjectTypeIds = new Set(objectTypesById.keys())
  const registeredValueTypes = ontology.getValueTypesById()
  const valueTypesById = options.includeAllValueTypes
    ? new ImmutableReadonlyMap(
        [...registeredValueTypes.values()].map((valueType) => {
          const snapshot = snapshotValueType(valueType)
          return [snapshot.id, snapshot] as const
        })
      )
    : collectVisibleValueTypes(registeredValueTypes, objectTypes)

  return {
    listObjectTypes: () => [...objectTypesById.values()],
    getObjectTypeById: (objectTypeId) => objectTypesById.get(objectTypeId) ?? null,
    resolveObjectType: (objectTypeId) =>
      objectTypesById.get(objectTypeId) ?? unknownObjectType(objectTypeId),
    getValueTypesById: () => valueTypesById,
    getPrimaryPropertyId: (objectTypeId) => {
      const objectType = objectTypesById.get(objectTypeId)
      if (!objectType) return unknownObjectType(objectTypeId)
      const primary = objectType.properties.find((property) => property.primary)
      if (!primary) {
        throw new OntologyValidationError(
          `[Sixb] Object type '${objectTypeId}' does not expose its primary property in this runtime scope.`
        )
      }
      return primary.id
    },
    listSubTypes: (objectTypeId) =>
      visibleObjectTypeIds.has(objectTypeId)
        ? ontology
            .listSubTypes(objectTypeId)
            .filter((subTypeId) => visibleObjectTypeIds.has(subTypeId))
        : [],
    isValidLinkTarget: (expected, actual) => {
      if (!visibleObjectTypeIds.has(actual)) return false
      const expectedTypes = Array.isArray(expected) ? expected : [expected]
      const visibleExpected = expectedTypes.filter(
        (objectTypeId) => objectTypeId === "*" || visibleObjectTypeIds.has(objectTypeId)
      )
      return visibleExpected.some(
        (objectTypeId) => objectTypeId === "*" || ontology.isValidLinkTarget(objectTypeId, actual)
      )
    },
  }
}

function collectVisibleValueTypes(
  registered: ReadonlyMap<string, ValueType>,
  objectTypes: readonly ObjectTypeWithPropertyTokens[]
): ReadonlyMap<string, ValueType> {
  const referencedIds = new Set<string>()
  const pendingSchemas: Schema[] = []
  for (const objectType of objectTypes) {
    for (const property of objectType.properties) pendingSchemas.push(property.schema)
    for (const link of objectType.links) {
      for (const property of link.properties ?? []) pendingSchemas.push(property.schema)
    }
  }

  const visitedSchemas = new Set<object>()
  const pendingValueTypeIds: string[] = []
  while (pendingSchemas.length > 0 || pendingValueTypeIds.length > 0) {
    const schema = pendingSchemas.pop()
    if (schema !== undefined) {
      if (typeof schema === "string" || visitedSchemas.has(schema)) continue
      visitedSchemas.add(schema)
      if (schema.type === "valueTypeRef") {
        if (!referencedIds.has(schema.valueTypeId)) {
          referencedIds.add(schema.valueTypeId)
          pendingValueTypeIds.push(schema.valueTypeId)
        }
      } else if (schema.type === "object") {
        for (const field of Object.values(schema.properties)) pendingSchemas.push(field.schema)
      } else if (schema.type === "array") {
        pendingSchemas.push(schema.items)
      } else if (schema.type === "map") {
        pendingSchemas.push(schema.valueSchema)
      }
      continue
    }

    const valueTypeId = pendingValueTypeIds.pop()!
    const valueType = registered.get(valueTypeId)
    if (valueType) pendingSchemas.push(valueType.schema)
  }

  return new ImmutableReadonlyMap(
    [...referencedIds]
      .map((valueTypeId) => registered.get(valueTypeId))
      .filter((valueType): valueType is ValueType => valueType !== undefined)
      .map((valueType) => {
        const snapshot = snapshotValueType(valueType)
        return [snapshot.id, snapshot] as const
      })
  )
}

function snapshotProperty(property: Property): Property {
  return Object.freeze({
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
  })
}

function snapshotPropertyQuery(
  query: PropertyQueryMetadata | undefined
): PropertyQueryMetadata | undefined {
  if (!query) return undefined
  return Object.freeze({
    searchable: query.searchable,
    filterable: query.filterable,
    sortable: query.sortable,
    text: query.text,
    exact: query.exact,
    facet: query.facet,
    vector: query.vector,
    weight: query.weight,
  })
}

function snapshotLink(
  link: ObjectLink,
  targetObjectTypeId: string | string[],
  propertyIds: ReadonlySet<string>
): ObjectLink {
  return Object.freeze({
    id: link.id,
    name: link.name,
    description: link.description,
    targetObjectTypeId: snapshotLinkTarget(targetObjectTypeId),
    cardinality: link.cardinality,
    properties: link.properties
      ? frozenArray(
          link.properties.filter((property) => propertyIds.has(property.id)).map(snapshotProperty)
        )
      : undefined,
  })
}

function snapshotLinkTarget(targetObjectTypeId: string | readonly string[]): string | string[] {
  return typeof targetObjectTypeId === "string"
    ? targetObjectTypeId
    : frozenArray(targetObjectTypeId)
}

function snapshotValueType(valueType: ValueType): ValueType {
  return Object.freeze({
    id: valueType.id,
    name: valueType.name,
    description: valueType.description,
    schema: snapshotSchema(valueType.schema),
    semanticType: valueType.semanticType,
  })
}

function snapshotSchema(schema: Schema): Schema {
  if (typeof schema === "string") return schema
  if (schema.type === "valueTypeRef") {
    return Object.freeze({
      type: schema.type,
      valueTypeId: schema.valueTypeId,
      ...(schema._resolved === undefined ? {} : { _resolved: snapshotSchema(schema._resolved) }),
    })
  }
  if (schema.type === "array") {
    return Object.freeze({ type: schema.type, items: snapshotSchema(schema.items) })
  }
  if (schema.type === "map") {
    return Object.freeze({
      type: schema.type,
      keySchema: schema.keySchema,
      valueSchema: snapshotSchema(schema.valueSchema),
    })
  }
  if (schema.type === "object") {
    const properties = Object.fromEntries(
      Object.entries(schema.properties).map(([propertyId, field]) => [
        propertyId,
        Object.freeze({
          description: field.description,
          required: field.required,
          semanticType: field.semanticType,
          nullable: field.nullable,
          schema: snapshotSchema(field.schema),
        }),
      ])
    )
    return Object.freeze({ type: schema.type, properties: Object.freeze(properties) })
  }
  if (schema.valueType === "string") {
    return Object.freeze({
      type: schema.type,
      valueType: schema.valueType,
      values: frozenArray(schema.values),
    })
  }
  return Object.freeze({
    type: schema.type,
    valueType: schema.valueType,
    values: frozenArray(schema.values),
  })
}

function frozenArray<T>(values: readonly T[]): T[] {
  return Object.freeze([...values]) as T[]
}

function immutableCatalogMutation(): Error {
  return new Error("[Sixb] Scoped ontology catalog is immutable.")
}

function unknownObjectType(objectTypeId: string): never {
  throw new OntologyNotFoundError(formatUnknownObjectTypeMessage(objectTypeId))
}
