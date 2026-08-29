import type {
  AllObjectReadScope,
  CompiledObjectReadObjectSelection,
  CompiledObjectReadRoot,
  CompiledObjectReadScope,
  CompiledObjectReadStep,
  ObjectReadLinkDefinitionSelection,
  ObjectReadNode,
  ObjectReadObjectSelection,
  ObjectReadScope,
} from "./types"

const ALL_OBJECTS_SCOPE: AllObjectReadScope = Object.freeze({ kind: "all" })
/** Internal capture/compile limits shared with delegated access-plan admission. */
export const OBJECT_READ_SCOPE_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 512,
  maxObjectSelections: 4_096,
  maxSteps: 2_048,
  maxPropertyOccurrences: 16_384,
  maxIdentifierCharacters: 1_000_000,
})
const MAX_SCOPE_DEPTH = OBJECT_READ_SCOPE_LIMITS.maxDepth
const MAX_SCOPE_NODES = OBJECT_READ_SCOPE_LIMITS.maxNodes
const MAX_SCOPE_OBJECT_SELECTIONS = OBJECT_READ_SCOPE_LIMITS.maxObjectSelections
const MAX_SCOPE_STEPS = OBJECT_READ_SCOPE_LIMITS.maxSteps
const MAX_SCOPE_PROPERTY_OCCURRENCES = OBJECT_READ_SCOPE_LIMITS.maxPropertyOccurrences
const MAX_SCOPE_IDENTIFIER_CHARACTERS = OBJECT_READ_SCOPE_LIMITS.maxIdentifierCharacters

/**
 * Validate, detach, and flatten a recursive read scope for a storage provider.
 *
 * Every node occurrence receives its own id. Reusing only `(sourceType, linkId)` would lose path
 * provenance and could grant a nested link from an object reached through another branch.
 */
export function compileObjectReadScope(scope: ObjectReadScope): CompiledObjectReadScope {
  if (!isRecord(scope)) {
    throw invalidScope("scope must be an object")
  }
  if (scope.kind === "all") return ALL_OBJECTS_SCOPE
  if (scope.kind !== "selected" || !Array.isArray(scope.roots)) {
    throw invalidScope("scope kind must be 'all' or 'selected'")
  }

  const roots: CompiledObjectReadRoot[] = []
  const objects: CompiledObjectReadObjectSelection[] = []
  const steps: CompiledObjectReadStep[] = []
  const visiting = new Set<object>()
  let nextNodeId = 0
  let concreteStepCount = 0
  let objectSelectionCount = 0
  let propertyOccurrenceCount = 0
  let identifierCharacterCount = 0
  let compiledPropertyOccurrenceCount = 0
  let compiledIdentifierCharacterCount = 0

  const addIdentifier = (value: unknown, path: string): string => {
    const identifier = nonEmptyString(value, path)
    identifierCharacterCount += identifier.length
    if (identifierCharacterCount > MAX_SCOPE_IDENTIFIER_CHARACTERS) {
      throw invalidScope(
        `scope exceeds the maximum of ${MAX_SCOPE_IDENTIFIER_CHARACTERS} identifier characters`
      )
    }
    return identifier
  }

  const addPropertyOccurrences = (count: number): void => {
    propertyOccurrenceCount += count
    if (propertyOccurrenceCount > MAX_SCOPE_PROPERTY_OCCURRENCES) {
      throw invalidScope(
        `scope exceeds the maximum of ${MAX_SCOPE_PROPERTY_OCCURRENCES} selected property occurrences`
      )
    }
  }

  const addCompiledPropertyOccurrences = (count: number): void => {
    compiledPropertyOccurrenceCount += count
    if (compiledPropertyOccurrenceCount > MAX_SCOPE_PROPERTY_OCCURRENCES) {
      throw invalidScope(
        `scope exceeds the maximum of ${MAX_SCOPE_PROPERTY_OCCURRENCES} selected property occurrences`
      )
    }
  }

  const addCompiledIdentifiers = (values: readonly string[]): void => {
    compiledIdentifierCharacterCount += values.reduce((total, value) => total + value.length, 0)
    if (compiledIdentifierCharacterCount > MAX_SCOPE_IDENTIFIER_CHARACTERS) {
      throw invalidScope(
        `scope exceeds the maximum of ${MAX_SCOPE_IDENTIFIER_CHARACTERS} identifier characters`
      )
    }
  }

  const visitNode = (node: ObjectReadNode, path: string, depth: number): number => {
    if (!isRecord(node) || !Array.isArray(node.objects) || !Array.isArray(node.links)) {
      throw invalidScope(`${path} must contain object and link selections`)
    }
    if (depth > MAX_SCOPE_DEPTH) {
      throw invalidScope(`${path} exceeds the maximum link depth of ${MAX_SCOPE_DEPTH}`)
    }
    if (nextNodeId >= MAX_SCOPE_NODES) {
      throw invalidScope(`scope exceeds the maximum of ${MAX_SCOPE_NODES} selection nodes`)
    }
    if (visiting.has(node)) {
      throw invalidScope(`${path} contains a cyclic selection node`)
    }
    visiting.add(node)

    const nodeId = nextNodeId++
    try {
      objectSelectionCount += node.objects.length
      if (objectSelectionCount > MAX_SCOPE_OBJECT_SELECTIONS) {
        throw invalidScope(
          `scope exceeds the maximum of ${MAX_SCOPE_OBJECT_SELECTIONS} object selections`
        )
      }
      for (const [objectIndex, object] of node.objects.entries()) {
        const objectPath = `${path}.objects[${objectIndex}]`
        if (!isRecord(object) || !Array.isArray(object.propertyIds)) {
          throw invalidScope(`${objectPath} must contain an object type and property ids`)
        }
        addIdentifier(object.objectTypeId, `${objectPath}.objectTypeId`)
        addPropertyOccurrences(object.propertyIds.length)
        for (const [propertyIndex, propertyId] of object.propertyIds.entries()) {
          addIdentifier(propertyId, `${objectPath}.propertyIds[${propertyIndex}]`)
        }
      }

      const normalizedObjects = normalizeObjects(node.objects, `${path}.objects`)
      if (normalizedObjects.length === 0) {
        throw invalidScope(`${path}.objects must contain at least one concrete object type`)
      }
      for (const object of normalizedObjects) {
        addCompiledPropertyOccurrences(object.propertyIds.length)
        addCompiledIdentifiers([object.objectTypeId, ...object.propertyIds])
        objects.push(Object.freeze({ nodeId, ...object }))
      }

      for (const [linkIndex, link] of node.links.entries()) {
        const linkPath = `${path}.links[${linkIndex}]`
        if (!isRecord(link) || !Array.isArray(link.definitions) || !isRecord(link.target)) {
          throw invalidScope(`${linkPath} must contain definitions and a target node`)
        }
        if (link.definitions.length === 0) {
          throw invalidScope(`${linkPath}.definitions must not be empty`)
        }

        for (const [definitionIndex, definition] of link.definitions.entries()) {
          const definitionPath = `${linkPath}.definitions[${definitionIndex}]`
          if (
            !isRecord(definition) ||
            !Array.isArray(definition.targetObjectTypeIds) ||
            !Array.isArray(definition.propertyIds)
          ) {
            throw invalidScope(`${definitionPath} must contain a concrete link definition`)
          }
          addIdentifier(definition.sourceObjectTypeId, `${definitionPath}.sourceObjectTypeId`)
          addIdentifier(definition.linkId, `${definitionPath}.linkId`)
          if (definition.targetObjectTypeIds.length === 0) {
            throw invalidScope(`${definitionPath}.targetObjectTypeIds must not be empty`)
          }
          concreteStepCount += definition.targetObjectTypeIds.length
          if (concreteStepCount > MAX_SCOPE_STEPS) {
            throw invalidScope(
              `scope exceeds the maximum of ${MAX_SCOPE_STEPS} concrete link steps`
            )
          }
          for (const [
            targetIndex,
            targetObjectTypeId,
          ] of definition.targetObjectTypeIds.entries()) {
            addIdentifier(
              targetObjectTypeId,
              `${definitionPath}.targetObjectTypeIds[${targetIndex}]`
            )
          }
          addPropertyOccurrences(definition.propertyIds.length)
          for (const [propertyIndex, propertyId] of definition.propertyIds.entries()) {
            addIdentifier(propertyId, `${definitionPath}.propertyIds[${propertyIndex}]`)
          }
        }

        const definitions = normalizeDefinitions(link.definitions, `${linkPath}.definitions`)
        const parentTypes = new Set(normalizedObjects.map((object) => object.objectTypeId))
        for (const definition of definitions) {
          if (!parentTypes.has(definition.sourceObjectTypeId)) {
            throw invalidScope(
              `${linkPath} selects source type '${definition.sourceObjectTypeId}' outside its parent node`
            )
          }
          for (const targetObjectTypeId of definition.targetObjectTypeIds) {
            addCompiledPropertyOccurrences(definition.propertyIds.length)
            addCompiledIdentifiers([
              definition.sourceObjectTypeId,
              definition.linkId,
              targetObjectTypeId,
              ...definition.propertyIds,
            ])
          }
        }

        const childNodeId = visitNode(
          link.target as unknown as ObjectReadNode,
          `${linkPath}.target`,
          depth + 1
        )
        const childTypes = new Set(
          objects
            .filter((object) => object.nodeId === childNodeId)
            .map((object) => object.objectTypeId)
        )
        const targetTypes = new Set(
          definitions.flatMap((definition) => definition.targetObjectTypeIds)
        )
        if (!setsEqual(childTypes, targetTypes)) {
          throw invalidScope(
            `${linkPath}.target object types must exactly match its definition target types`
          )
        }

        for (const definition of definitions) {
          for (const targetObjectTypeId of definition.targetObjectTypeIds) {
            steps.push(
              Object.freeze({
                nodeId: childNodeId,
                parentNodeId: nodeId,
                sourceObjectTypeId: definition.sourceObjectTypeId,
                linkId: definition.linkId,
                targetObjectTypeId,
                propertyIds: definition.propertyIds,
              })
            )
          }
        }
      }
    } finally {
      visiting.delete(node)
    }

    return nodeId
  }

  for (const [rootIndex, root] of scope.roots.entries()) {
    const path = `roots[${rootIndex}]`
    if (!isRecord(root) || !isRecord(root.anchor) || !isRecord(root.node)) {
      throw invalidScope(`${path} must contain an exact anchor and a selection node`)
    }
    const objectTypeId = addIdentifier(root.anchor.objectTypeId, `${path}.anchor.objectTypeId`)
    const primaryId = addIdentifier(root.anchor.primaryId, `${path}.anchor.primaryId`)
    addCompiledIdentifiers([objectTypeId, primaryId])
    const nodeId = visitNode(root.node as unknown as ObjectReadNode, `${path}.node`, 0)
    if (
      !objects.some((object) => object.nodeId === nodeId && object.objectTypeId === objectTypeId)
    ) {
      throw invalidScope(`${path}.anchor type '${objectTypeId}' is not selected by its root node`)
    }
    roots.push(Object.freeze({ nodeId, objectTypeId, primaryId }))
  }

  return Object.freeze({
    kind: "selected",
    roots: Object.freeze(roots),
    objects: Object.freeze(objects),
    steps: Object.freeze(steps),
  })
}

/** Fail closed when a project-bound reader is accidentally reused across projects. */
export function assertObjectReaderProject(
  expectedProjectId: string,
  actualProjectId: string
): void {
  if (actualProjectId !== expectedProjectId) {
    throw new Error(
      `[Sixb] Object reader belongs to project '${expectedProjectId}', not '${actualProjectId}'.`
    )
  }
}

function normalizeObjects(
  selections: readonly ObjectReadObjectSelection[],
  path: string
): readonly ObjectReadObjectSelection[] {
  const propertiesByType = new Map<string, Set<string>>()
  for (const [index, selection] of selections.entries()) {
    if (!isRecord(selection) || !Array.isArray(selection.propertyIds)) {
      throw invalidScope(`${path}[${index}] must contain an object type and property ids`)
    }
    const objectTypeId = nonEmptyString(selection.objectTypeId, `${path}[${index}].objectTypeId`)
    const properties = propertiesByType.get(objectTypeId) ?? new Set<string>()
    for (const propertyId of normalizeIds(selection.propertyIds, `${path}[${index}].propertyIds`)) {
      properties.add(propertyId)
    }
    propertiesByType.set(objectTypeId, properties)
  }
  return [...propertiesByType]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([objectTypeId, properties]) =>
      Object.freeze({ objectTypeId, propertyIds: Object.freeze([...properties].sort()) })
    )
}

function normalizeDefinitions(
  definitions: readonly ObjectReadLinkDefinitionSelection[],
  path: string
): readonly ObjectReadLinkDefinitionSelection[] {
  const normalized: ObjectReadLinkDefinitionSelection[] = []
  for (const [index, definition] of definitions.entries()) {
    if (
      !isRecord(definition) ||
      !Array.isArray(definition.targetObjectTypeIds) ||
      !Array.isArray(definition.propertyIds)
    ) {
      throw invalidScope(`${path}[${index}] must contain a concrete link definition`)
    }
    const sourceObjectTypeId = nonEmptyString(
      definition.sourceObjectTypeId,
      `${path}[${index}].sourceObjectTypeId`
    )
    const linkId = nonEmptyString(definition.linkId, `${path}[${index}].linkId`)
    const targetObjectTypeIds = normalizeIds(
      definition.targetObjectTypeIds,
      `${path}[${index}].targetObjectTypeIds`
    )
    if (targetObjectTypeIds.length === 0) {
      throw invalidScope(`${path}[${index}].targetObjectTypeIds must not be empty`)
    }
    normalized.push(
      Object.freeze({
        sourceObjectTypeId,
        linkId,
        targetObjectTypeIds: Object.freeze(targetObjectTypeIds),
        propertyIds: Object.freeze(
          normalizeIds(definition.propertyIds, `${path}[${index}].propertyIds`)
        ),
      })
    )
  }
  return normalized
}

function normalizeIds(values: readonly string[], path: string): string[] {
  return [
    ...new Set(values.map((value, index) => nonEmptyString(value, `${path}[${index}]`))),
  ].sort()
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidScope(`${path} must be a non-empty string`)
  }
  return value
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function invalidScope(message: string): Error {
  return new Error(`[Sixb] Invalid object read scope: ${message}.`)
}
