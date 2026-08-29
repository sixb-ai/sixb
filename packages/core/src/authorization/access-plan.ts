import type { ObjectRef } from "../ontology"
import { compileObjectReadScope, OBJECT_READ_SCOPE_LIMITS } from "../storage/objects/read-scope"
import type {
  ObjectReadLinkDefinitionSelection,
  ObjectReadLinkSelection,
  ObjectReadNode,
  ObjectReadObjectSelection,
  ObjectReadRoot,
  SelectedObjectReadScope,
} from "../storage/objects/types"

const MAX_SCOPED_GRANTS = 1_024
const MAX_SCOPED_VIEW_ROOTS_BEFORE_COMPILATION = 1_024
const MAX_SCOPED_ACTION_SUBJECTS = 4_096
const MAX_SCOPED_ACTION_IDENTIFIER_CHARACTERS = 1_000_000

/** One capability paired with the exact resources it authorizes. */
export type RuntimeScopedGrant = RuntimeScopedViewGrant | RuntimeScopedActionGrant

export interface RuntimeScopedViewGrant {
  readonly kind: "object.view"
  readonly selection: SelectedObjectReadScope
}

export interface RuntimeScopedActionGrant {
  readonly kind: "action.apply"
  readonly actionId: string
  readonly subjects: readonly ObjectRef[]
}

/** Internal authority compiled from a delegation such as a shared-access grant. */
export interface RuntimeAccessPlan {
  readonly grants: readonly RuntimeScopedGrant[]
}

type CapturedGrant =
  | { readonly kind: "object.view"; readonly rootStart: number; readonly rootCount: number }
  | RuntimeScopedActionGrant

interface ReadScopeCaptureBudget {
  nodes: number
  objectSelections: number
  steps: number
  propertyOccurrences: number
  identifierCharacters: number
}

/** Validate and detach an access plan before registering process-local authority. */
export function snapshotRuntimeAccessPlan(input: RuntimeAccessPlan): RuntimeAccessPlan {
  if (!isRecord(input)) {
    throw new Error("[Sixb] Runtime access plan must contain scoped grants.")
  }
  const authoredGrants = input.grants
  if (!Array.isArray(authoredGrants)) {
    throw new Error("[Sixb] Runtime access plan must contain scoped grants.")
  }
  const grantCount = authoredGrants.length
  if (grantCount > MAX_SCOPED_GRANTS) {
    throw new Error(
      `[Sixb] Runtime access plan exceeds the maximum of ${MAX_SCOPED_GRANTS} scoped grants.`
    )
  }

  let actionSubjectCount = 0
  let actionIdentifierCharacters = 0
  const addActionIdentifierCharacters = (count: number): void => {
    actionIdentifierCharacters += count
    if (actionIdentifierCharacters > MAX_SCOPED_ACTION_IDENTIFIER_CHARACTERS) {
      throw new Error(
        `[Sixb] Runtime access plan exceeds the maximum of ${MAX_SCOPED_ACTION_IDENTIFIER_CHARACTERS} scoped action identifier characters.`
      )
    }
  }

  // Capture each hostile top-level property exactly once. View roots are first collected into one
  // bounded array, then snapshotted together so the provider's limits apply globally across grants.
  const mergedAuthoredViewRoots: ObjectReadRoot[] = []
  const capturedGrants: CapturedGrant[] = []
  for (let index = 0; index < grantCount; index += 1) {
    const grant = authoredGrants[index]
    if (!isRecord(grant)) {
      throw new Error(`[Sixb] Scoped grant ${index} must be an object.`)
    }
    const kind = grant.kind
    if (kind === "object.view") {
      const selection = grant.selection
      if (!isRecord(selection)) {
        throw new Error(`[Sixb] Scoped grant ${index} requires a selected object read scope.`)
      }
      const selectionKind = selection.kind
      const roots = selection.roots
      if (selectionKind !== "selected" || !Array.isArray(roots)) {
        throw new Error(`[Sixb] Scoped grant ${index} requires a selected object read scope.`)
      }
      const rootCount = roots.length
      if (rootCount > MAX_SCOPED_VIEW_ROOTS_BEFORE_COMPILATION - mergedAuthoredViewRoots.length) {
        throw new Error(
          `[Sixb] Runtime access plan exceeds the maximum of ${MAX_SCOPED_VIEW_ROOTS_BEFORE_COMPILATION} raw scoped view roots.`
        )
      }
      const rootStart = mergedAuthoredViewRoots.length
      for (let rootIndex = 0; rootIndex < rootCount; rootIndex += 1) {
        mergedAuthoredViewRoots.push(roots[rootIndex] as ObjectReadRoot)
      }
      capturedGrants.push({ kind, rootStart, rootCount })
      continue
    }
    if (kind === "action.apply") {
      const authoredActionId = grant.actionId
      const authoredSubjects = grant.subjects
      const actionId = nonEmpty(authoredActionId, `Scoped grant ${index} action id`)
      addActionIdentifierCharacters(actionId.length)
      if (!Array.isArray(authoredSubjects)) {
        throw new Error(`[Sixb] Scoped grant ${index} action subjects must be an array.`)
      }
      const subjectCount = authoredSubjects.length
      actionSubjectCount += subjectCount
      if (actionSubjectCount > MAX_SCOPED_ACTION_SUBJECTS) {
        throw new Error(
          `[Sixb] Runtime access plan exceeds the maximum of ${MAX_SCOPED_ACTION_SUBJECTS} scoped action subjects.`
        )
      }
      const subjects: ObjectRef[] = []
      for (let subjectIndex = 0; subjectIndex < subjectCount; subjectIndex += 1) {
        const subject = authoredSubjects[subjectIndex]
        if (!isRecord(subject)) {
          throw new Error(`[Sixb] Scoped grant ${index} subject ${subjectIndex} must be an object.`)
        }
        const authoredObjectTypeId = subject.objectTypeId
        const authoredPrimaryId = subject.primaryId
        const objectTypeId = nonEmpty(
          authoredObjectTypeId,
          `Scoped grant ${index} subject ${subjectIndex} object type id`
        )
        const primaryId = nonEmpty(
          authoredPrimaryId,
          `Scoped grant ${index} subject ${subjectIndex} primary id`
        )
        addActionIdentifierCharacters(objectTypeId.length + primaryId.length)
        subjects.push(Object.freeze({ objectTypeId, primaryId }))
      }
      capturedGrants.push(
        Object.freeze({
          kind,
          actionId,
          subjects: Object.freeze(subjects),
        })
      )
      continue
    }
    throw new Error(`[Sixb] Unknown scoped grant kind '${String(kind)}'.`)
  }

  const mergedSelection = snapshotSelection({
    kind: "selected",
    roots: mergedAuthoredViewRoots,
  })
  // Compile the exact immutable snapshot that will be registered. This verifies normalized shape
  // limits and link/path invariants without a second read of caller-controlled data.
  compileObjectReadScope(mergedSelection)

  const grants = capturedGrants.map((grant): RuntimeScopedGrant => {
    if (grant.kind === "action.apply") return grant
    const roots = Object.freeze(
      mergedSelection.roots.slice(grant.rootStart, grant.rootStart + grant.rootCount)
    )
    return Object.freeze({
      kind: "object.view",
      selection: Object.freeze({ kind: "selected", roots }),
    })
  })

  return Object.freeze({ grants: Object.freeze(grants) })
}

function snapshotSelection(selection: SelectedObjectReadScope): SelectedObjectReadScope {
  const authoredRoots = selection.roots
  const rootCount = authoredRoots.length
  const budget: ReadScopeCaptureBudget = {
    nodes: 0,
    objectSelections: 0,
    steps: 0,
    propertyOccurrences: 0,
    identifierCharacters: 0,
  }
  const visiting = new Set<object>()
  const roots: ObjectReadRoot[] = []
  for (let index = 0; index < rootCount; index += 1) {
    const root = authoredRoots[index]
    const path = `roots[${index}]`
    if (!isRecord(root)) throw invalidReadScope(`${path} must contain an exact anchor and a node`)
    const anchor = root.anchor
    const node = root.node
    if (!isRecord(anchor) || !isRecord(node)) {
      throw invalidReadScope(`${path} must contain an exact anchor and a selection node`)
    }
    const authoredObjectTypeId = anchor.objectTypeId
    const authoredPrimaryId = anchor.primaryId
    const objectTypeId = captureIdentifier(
      authoredObjectTypeId,
      `${path}.anchor.objectTypeId`,
      budget
    )
    const primaryId = captureIdentifier(authoredPrimaryId, `${path}.anchor.primaryId`, budget)
    roots.push(
      Object.freeze({
        anchor: Object.freeze({ objectTypeId, primaryId }),
        node: snapshotNode(node, `${path}.node`, 0, budget, visiting),
      })
    )
  }
  return Object.freeze({ kind: "selected", roots: Object.freeze(roots) })
}

function snapshotNode(
  node: Record<string, unknown>,
  path: string,
  depth: number,
  budget: ReadScopeCaptureBudget,
  visiting: Set<object>
): ObjectReadNode {
  if (depth > OBJECT_READ_SCOPE_LIMITS.maxDepth) {
    throw invalidReadScope(
      `${path} exceeds the maximum link depth of ${OBJECT_READ_SCOPE_LIMITS.maxDepth}`
    )
  }
  if (visiting.has(node)) throw invalidReadScope(`${path} contains a cyclic selection node`)
  budget.nodes += 1
  if (budget.nodes > OBJECT_READ_SCOPE_LIMITS.maxNodes) {
    throw invalidReadScope(
      `scope exceeds the maximum of ${OBJECT_READ_SCOPE_LIMITS.maxNodes} selection nodes`
    )
  }

  const authoredObjects = node.objects
  const authoredLinks = node.links
  if (!Array.isArray(authoredObjects) || !Array.isArray(authoredLinks)) {
    throw invalidReadScope(`${path} must contain object and link selections`)
  }
  const objectCount = authoredObjects.length
  const linkCount = authoredLinks.length
  budget.objectSelections += objectCount
  if (budget.objectSelections > OBJECT_READ_SCOPE_LIMITS.maxObjectSelections) {
    throw invalidReadScope(
      `scope exceeds the maximum of ${OBJECT_READ_SCOPE_LIMITS.maxObjectSelections} object selections`
    )
  }

  visiting.add(node)
  try {
    const objects: ObjectReadObjectSelection[] = []
    for (let index = 0; index < objectCount; index += 1) {
      const object = authoredObjects[index]
      const objectPath = `${path}.objects[${index}]`
      if (!isRecord(object)) {
        throw invalidReadScope(`${objectPath} must contain an object type and property ids`)
      }
      const authoredObjectTypeId = object.objectTypeId
      const authoredPropertyIds = object.propertyIds
      if (!Array.isArray(authoredPropertyIds)) {
        throw invalidReadScope(`${objectPath} must contain an object type and property ids`)
      }
      const objectTypeId = captureIdentifier(
        authoredObjectTypeId,
        `${objectPath}.objectTypeId`,
        budget
      )
      const propertyIds = captureIdentifiers(
        authoredPropertyIds,
        `${objectPath}.propertyIds`,
        budget
      )
      objects.push(Object.freeze({ objectTypeId, propertyIds }))
    }

    const links: ObjectReadLinkSelection[] = []
    for (let index = 0; index < linkCount; index += 1) {
      const link = authoredLinks[index]
      const linkPath = `${path}.links[${index}]`
      if (!isRecord(link)) {
        throw invalidReadScope(`${linkPath} must contain definitions and a target node`)
      }
      const authoredDefinitions = link.definitions
      const target = link.target
      if (!Array.isArray(authoredDefinitions) || !isRecord(target)) {
        throw invalidReadScope(`${linkPath} must contain definitions and a target node`)
      }
      const definitionCount = authoredDefinitions.length
      if (definitionCount === 0) {
        throw invalidReadScope(`${linkPath}.definitions must not be empty`)
      }
      const definitions: ObjectReadLinkDefinitionSelection[] = []
      for (let definitionIndex = 0; definitionIndex < definitionCount; definitionIndex += 1) {
        const definition = authoredDefinitions[definitionIndex]
        const definitionPath = `${linkPath}.definitions[${definitionIndex}]`
        if (!isRecord(definition)) {
          throw invalidReadScope(`${definitionPath} must contain a concrete link definition`)
        }
        const authoredSourceObjectTypeId = definition.sourceObjectTypeId
        const authoredLinkId = definition.linkId
        const authoredTargetObjectTypeIds = definition.targetObjectTypeIds
        const authoredPropertyIds = definition.propertyIds
        if (!Array.isArray(authoredTargetObjectTypeIds) || !Array.isArray(authoredPropertyIds)) {
          throw invalidReadScope(`${definitionPath} must contain a concrete link definition`)
        }
        const targetObjectTypeCount = authoredTargetObjectTypeIds.length
        if (targetObjectTypeCount === 0) {
          throw invalidReadScope(`${definitionPath}.targetObjectTypeIds must not be empty`)
        }
        budget.steps += targetObjectTypeCount
        if (budget.steps > OBJECT_READ_SCOPE_LIMITS.maxSteps) {
          throw invalidReadScope(
            `scope exceeds the maximum of ${OBJECT_READ_SCOPE_LIMITS.maxSteps} concrete link steps`
          )
        }
        const sourceObjectTypeId = captureIdentifier(
          authoredSourceObjectTypeId,
          `${definitionPath}.sourceObjectTypeId`,
          budget
        )
        const linkId = captureIdentifier(authoredLinkId, `${definitionPath}.linkId`, budget)
        const targetObjectTypeIds = captureIdentifiers(
          authoredTargetObjectTypeIds,
          `${definitionPath}.targetObjectTypeIds`,
          budget,
          false
        )
        const propertyIds = captureIdentifiers(
          authoredPropertyIds,
          `${definitionPath}.propertyIds`,
          budget
        )
        definitions.push(
          Object.freeze({ sourceObjectTypeId, linkId, targetObjectTypeIds, propertyIds })
        )
      }
      links.push(
        Object.freeze({
          definitions: Object.freeze(definitions),
          target: snapshotNode(target, `${linkPath}.target`, depth + 1, budget, visiting),
        })
      )
    }

    return Object.freeze({ objects: Object.freeze(objects), links: Object.freeze(links) })
  } finally {
    visiting.delete(node)
  }
}

function captureIdentifiers(
  values: readonly unknown[],
  path: string,
  budget: ReadScopeCaptureBudget,
  countAsProperties = true
): readonly string[] {
  const count = values.length
  if (countAsProperties) {
    budget.propertyOccurrences += count
    if (budget.propertyOccurrences > OBJECT_READ_SCOPE_LIMITS.maxPropertyOccurrences) {
      throw invalidReadScope(
        `scope exceeds the maximum of ${OBJECT_READ_SCOPE_LIMITS.maxPropertyOccurrences} selected property occurrences`
      )
    }
  }
  const captured: string[] = []
  for (let index = 0; index < count; index += 1) {
    captured.push(captureIdentifier(values[index], `${path}[${index}]`, budget))
  }
  return Object.freeze(captured)
}

function captureIdentifier(value: unknown, path: string, budget: ReadScopeCaptureBudget): string {
  const identifier = nonEmpty(value, path)
  budget.identifierCharacters += identifier.length
  if (budget.identifierCharacters > OBJECT_READ_SCOPE_LIMITS.maxIdentifierCharacters) {
    throw invalidReadScope(
      `scope exceeds the maximum of ${OBJECT_READ_SCOPE_LIMITS.maxIdentifierCharacters} identifier characters`
    )
  }
  return identifier
}

function invalidReadScope(message: string): Error {
  return new Error(`[Sixb] Invalid object read scope: ${message}.`)
}

/** Merge view grants only; capability/resource pairing remains intact for every other grant. */
export function objectReadScopeForAccessPlan(plan: RuntimeAccessPlan): SelectedObjectReadScope {
  return Object.freeze({
    kind: "selected",
    roots: Object.freeze(
      plan.grants.flatMap((grant) =>
        grant.kind === "object.view" ? [...grant.selection.roots] : []
      )
    ),
  })
}

/** Coarse catalog check only; exact object authority remains enforced by the scoped reader. */
export function accessPlanSelectsObjectTypeAnywhere(
  plan: RuntimeAccessPlan,
  objectTypeId: string
): boolean {
  return plan.grants.some(
    (grant) =>
      grant.kind === "object.view" &&
      grant.selection.roots.some((root) => nodeContainsObjectType(root.node, objectTypeId))
  )
}

/** Coarse schema check only; exact object authority remains enforced by the scoped reader. */
export function accessPlanSelectsObjectPropertyAnywhere(
  plan: RuntimeAccessPlan,
  objectTypeId: string,
  propertyId: string
): boolean {
  return plan.grants.some(
    (grant) =>
      grant.kind === "object.view" &&
      grant.selection.roots.some((root) =>
        nodeContainsObjectProperty(root.node, objectTypeId, propertyId)
      )
  )
}

export function accessPlanCanApplyAction(plan: RuntimeAccessPlan, actionId: string): boolean {
  return plan.grants.some((grant) => grant.kind === "action.apply" && grant.actionId === actionId)
}

/** Whether one exact action grant names a subject of this concrete object type. */
export function accessPlanCanApplyActionToObjectType(
  plan: RuntimeAccessPlan,
  actionId: string,
  objectTypeId: string
): boolean {
  return plan.grants.some(
    (grant) =>
      grant.kind === "action.apply" &&
      grant.actionId === actionId &&
      grant.subjects.some((subject) => subject.objectTypeId === objectTypeId)
  )
}

export function accessPlanCanApplyActionOn(
  plan: RuntimeAccessPlan,
  actionId: string,
  subject: ObjectRef
): boolean {
  return plan.grants.some(
    (grant) =>
      grant.kind === "action.apply" &&
      grant.actionId === actionId &&
      grant.subjects.some(
        (allowed) =>
          allowed.objectTypeId === subject.objectTypeId && allowed.primaryId === subject.primaryId
      )
  )
}

function nodeContainsObjectType(node: ObjectReadNode, objectTypeId: string): boolean {
  return (
    node.objects.some((object) => object.objectTypeId === objectTypeId) ||
    node.links.some((link) => nodeContainsObjectType(link.target, objectTypeId))
  )
}

function nodeContainsObjectProperty(
  node: ObjectReadNode,
  objectTypeId: string,
  propertyId: string
): boolean {
  return (
    node.objects.some(
      (object) => object.objectTypeId === objectTypeId && object.propertyIds.includes(propertyId)
    ) ||
    node.links.some((link) => nodeContainsObjectProperty(link.target, objectTypeId, propertyId))
  )
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`[Sixb] ${label} must not be empty.`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
