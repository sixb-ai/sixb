import type {
  CompiledObjectReadObjectSelection,
  CompiledObjectReadRoot,
  CompiledObjectReadStep,
  CompiledSelectedObjectReadScope,
  ObjectReadLinkDefinitionSelection,
  ObjectReadNode,
  ObjectReadObjectSelection,
  SelectedObjectReadScope,
} from "./types"

/** Admission bounds applied before a raw selection is normalized or allocated by a provider. */
export const OBJECT_READ_SCOPE_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 512,
  maxObjectSelections: 4_096,
  maxSteps: 2_048,
  maxPropertyOccurrences: 16_384,
  maxIdentifierCharacters: 1_000_000,
})

/**
 * Validate, detach, normalize, and flatten a finite selection exactly once.
 *
 * Every path occurrence receives its own node id. Reusing only `(sourceType, linkId)` would lose
 * provenance and let an object reached through one branch borrow nested authority from another.
 */
export function compileSelectedObjectReadScope(
  scope: SelectedObjectReadScope
): CompiledSelectedObjectReadScope {
  if (!isRecord(scope) || scope.kind !== "selected" || !Array.isArray(scope.roots)) {
    throw invalidScope("scope must be a selected scope with a roots array")
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
    if (identifierCharacterCount > OBJECT_READ_SCOPE_LIMITS.maxIdentifierCharacters) {
      throw invalidScope(
        `scope exceeds the maximum of ${OBJECT_READ_SCOPE_LIMITS.maxIdentifierCharacters} identifier characters`
      )
    }
    return identifier
  }

  const addPropertyOccurrences = (count: number): void => {
    propertyOccurrenceCount += count
    if (propertyOccurrenceCount > OBJECT_READ_SCOPE_LIMITS.maxPropertyOccurrences) {
      throw invalidScope(
        `scope exceeds the maximum of ${OBJECT_READ_SCOPE_LIMITS.maxPropertyOccurrences} selected property occurrences`
      )
    }
  }

  const addCompiledPropertyOccurrences = (count: number): void => {
    compiledPropertyOccurrenceCount += count
    if (compiledPropertyOccurrenceCount > OBJECT_READ_SCOPE_LIMITS.maxPropertyOccurrences) {
      throw invalidScope(
        `scope exceeds the maximum of ${OBJECT_READ_SCOPE_LIMITS.maxPropertyOccurrences} selected property occurrences after compilation`
      )
    }
  }

  const addCompiledIdentifierCharacters = (count: number): void => {
    compiledIdentifierCharacterCount += count
    if (compiledIdentifierCharacterCount > OBJECT_READ_SCOPE_LIMITS.maxIdentifierCharacters) {
      throw invalidScope(
        `scope exceeds the maximum of ${OBJECT_READ_SCOPE_LIMITS.maxIdentifierCharacters} identifier characters after compilation`
      )
    }
  }

  const visitNode = (node: ObjectReadNode, path: string, depth: number): number => {
    if (!isRecord(node) || !Array.isArray(node.objects) || !Array.isArray(node.links)) {
      throw invalidScope(`${path} must contain object and link selections`)
    }
    if (depth > OBJECT_READ_SCOPE_LIMITS.maxDepth) {
      throw invalidScope(
        `${path} exceeds the maximum link depth of ${OBJECT_READ_SCOPE_LIMITS.maxDepth}`
      )
    }
    if (nextNodeId >= OBJECT_READ_SCOPE_LIMITS.maxNodes) {
      throw invalidScope(
        `scope exceeds the maximum of ${OBJECT_READ_SCOPE_LIMITS.maxNodes} selection nodes`
      )
    }
    if (visiting.has(node)) throw invalidScope(`${path} contains a cyclic selection node`)
    visiting.add(node)

    const nodeId = nextNodeId++
    try {
      objectSelectionCount += node.objects.length
      if (objectSelectionCount > OBJECT_READ_SCOPE_LIMITS.maxObjectSelections) {
        throw invalidScope(
          `scope exceeds the maximum of ${OBJECT_READ_SCOPE_LIMITS.maxObjectSelections} object selections`
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
        addCompiledIdentifierCharacters(
          object.objectTypeId.length + identifierCharacters(object.propertyIds)
        )
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

        const definitions = normalizeConcreteDefinitions(
          link.definitions,
          `${linkPath}.definitions`,
          addIdentifier,
          addPropertyOccurrences,
          addCompiledPropertyOccurrences,
          addCompiledIdentifierCharacters,
          () => {
            concreteStepCount += 1
            if (concreteStepCount > OBJECT_READ_SCOPE_LIMITS.maxSteps) {
              throw invalidScope(
                `scope exceeds the maximum of ${OBJECT_READ_SCOPE_LIMITS.maxSteps} concrete link steps`
              )
            }
          }
        )
        const parentTypes = new Set(normalizedObjects.map((object) => object.objectTypeId))
        for (const definition of definitions) {
          if (!parentTypes.has(definition.sourceObjectTypeId)) {
            throw invalidScope(
              `${linkPath} selects source type '${definition.sourceObjectTypeId}' outside its parent node`
            )
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
        const targetTypes = new Set(definitions.map((definition) => definition.targetObjectTypeId))
        if (!setsEqual(childTypes, targetTypes)) {
          throw invalidScope(
            `${linkPath}.target object types must exactly match its definition target types`
          )
        }

        for (const definition of definitions) {
          steps.push(
            Object.freeze({
              nodeId: childNodeId,
              parentNodeId: nodeId,
              ...definition,
            })
          )
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
    addCompiledIdentifierCharacters(objectTypeId.length + primaryId.length)
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

/** Fail closed when a project-bound selected reader is accidentally reused across projects. */
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

interface ConcreteDefinition {
  readonly sourceObjectTypeId: string
  readonly linkId: string
  readonly targetObjectTypeId: string
  readonly propertyIds: readonly string[]
}

function normalizeConcreteDefinitions(
  definitions: readonly ObjectReadLinkDefinitionSelection[],
  path: string,
  addIdentifier: (value: unknown, path: string) => string,
  addPropertyOccurrences: (count: number) => void,
  addCompiledPropertyOccurrences: (count: number) => void,
  addCompiledIdentifierCharacters: (count: number) => void,
  addConcreteStep: () => void
): readonly ConcreteDefinition[] {
  const propertiesByDefinition = new Map<
    string,
    {
      sourceObjectTypeId: string
      linkId: string
      targetObjectTypeId: string
      properties: Set<string>
    }
  >()

  for (const [index, definition] of definitions.entries()) {
    const definitionPath = `${path}[${index}]`
    if (
      !isRecord(definition) ||
      !Array.isArray(definition.targetObjectTypeIds) ||
      !Array.isArray(definition.propertyIds)
    ) {
      throw invalidScope(`${definitionPath} must contain a concrete link definition`)
    }
    const sourceObjectTypeId = addIdentifier(
      definition.sourceObjectTypeId,
      `${definitionPath}.sourceObjectTypeId`
    )
    const linkId = addIdentifier(definition.linkId, `${definitionPath}.linkId`)
    if (definition.targetObjectTypeIds.length === 0) {
      throw invalidScope(`${definitionPath}.targetObjectTypeIds must not be empty`)
    }
    addPropertyOccurrences(definition.propertyIds.length)
    let propertyIdentifierCharacters = 0
    for (const [propertyIndex, propertyId] of definition.propertyIds.entries()) {
      propertyIdentifierCharacters += addIdentifier(
        propertyId,
        `${definitionPath}.propertyIds[${propertyIndex}]`
      ).length
    }
    let targetIdentifierCharacters = 0
    for (const [targetIndex, value] of definition.targetObjectTypeIds.entries()) {
      addConcreteStep()
      targetIdentifierCharacters += addIdentifier(
        value,
        `${definitionPath}.targetObjectTypeIds[${targetIndex}]`
      ).length
    }

    // Reserve the complete concrete expansion before allocating collision-safe keys or copying
    // properties into per-target sets. One compact raw definition may otherwise amplify its
    // source/link/property identifiers once per target beyond the provider-neutral scope caps.
    addCompiledPropertyOccurrences(
      definition.propertyIds.length * definition.targetObjectTypeIds.length
    )
    const repeatedIdentifierCharacters =
      sourceObjectTypeId.length + linkId.length + propertyIdentifierCharacters
    addCompiledIdentifierCharacters(
      repeatedIdentifierCharacters * definition.targetObjectTypeIds.length +
        targetIdentifierCharacters
    )

    for (const [targetIndex, value] of definition.targetObjectTypeIds.entries()) {
      const targetObjectTypeId = nonEmptyString(
        value,
        `${definitionPath}.targetObjectTypeIds[${targetIndex}]`
      )
      const key = JSON.stringify([sourceObjectTypeId, linkId, targetObjectTypeId])
      const normalized = propertiesByDefinition.get(key) ?? {
        sourceObjectTypeId,
        linkId,
        targetObjectTypeId,
        properties: new Set<string>(),
      }
      for (const [propertyIndex, propertyId] of definition.propertyIds.entries()) {
        normalized.properties.add(
          nonEmptyString(propertyId, `${definitionPath}.propertyIds[${propertyIndex}]`)
        )
      }
      propertiesByDefinition.set(key, normalized)
    }
  }

  return [...propertiesByDefinition.values()]
    .sort(
      (left, right) =>
        left.sourceObjectTypeId.localeCompare(right.sourceObjectTypeId) ||
        left.linkId.localeCompare(right.linkId) ||
        left.targetObjectTypeId.localeCompare(right.targetObjectTypeId)
    )
    .map(({ properties, ...definition }) =>
      Object.freeze({
        ...definition,
        propertyIds: Object.freeze([...properties].sort()),
      })
    )
}

function identifierCharacters(values: readonly string[]): number {
  return values.reduce((total, value) => total + value.length, 0)
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
