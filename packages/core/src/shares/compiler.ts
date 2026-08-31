import type { ActionDefinitionCatalog } from "../actions"
import { type RuntimeAccessPlan, snapshotRuntimeAccessPlan } from "../authorization"
import type { LinkPathSelection, LinkPathSelectionMode, ObjectRef } from "../ontology"
import type { OntologyDefinitionCatalog } from "../ontology/registry"
import type { ObjectLink, ObjectType } from "../ontology/types"
import type {
  ObjectReadLinkDefinitionSelection,
  ObjectReadLinkSelection,
  ObjectReadNode,
  ObjectReadObjectSelection,
  ObjectReadRoot,
} from "../storage/objects/types"
import { snapshotShareDefinition } from "./builders"
import { ShareDefinitionError } from "./errors"
import type { ShareDefinition, ShareViewGrant } from "./types"

export interface CompileShareAccessPlanInput {
  readonly share: ShareDefinition
  readonly target: ObjectRef
  readonly ontology: OntologyDefinitionCatalog
  readonly actions: ActionDefinitionCatalog
}

/** Compile one current Share definition and exact target into M01 delegated authority. */
export function compileShareAccessPlan(input: CompileShareAccessPlanInput): RuntimeAccessPlan {
  const share = snapshotShareDefinition(input.share)
  const targetObjectTypeId = share.target.objectTypeId
  if (
    input.target.objectTypeId !== targetObjectTypeId ||
    typeof input.target.primaryId !== "string" ||
    !input.target.primaryId.trim()
  ) {
    throw invalid(`Share '${share.id}' requires an exact '${targetObjectTypeId}' object reference.`)
  }
  if (!input.ontology.getObjectTypeById(targetObjectTypeId)) {
    throw invalid(
      `Share '${share.id}' targets unknown object type '${targetObjectTypeId}'. Register it in the ontology before this Share.`
    )
  }

  const view = share.grants.find((grant): grant is ShareViewGrant => grant.kind === "object.view")
  if (!view) {
    throw invalid(`Share '${share.id}' must contain one view grant.`)
  }

  const root: ObjectReadRoot = {
    anchor: {
      objectTypeId: targetObjectTypeId,
      primaryId: input.target.primaryId,
    },
    node: compileNode(input.ontology, [targetObjectTypeId], view.links, share.id),
  }

  const grants: RuntimeAccessPlan["grants"][number][] = [
    {
      kind: "object.view",
      selection: { kind: "selected", roots: [root] },
    },
  ]

  for (const grant of share.grants) {
    if (grant.kind !== "action.apply") continue
    const action = input.actions.getById(grant.actionId)
    if (!action || action.binding.kind !== "object") {
      throw invalid(`Share '${share.id}' references unknown or global Action '${grant.actionId}'.`)
    }
    if (
      action.binding.objectType.id !== targetObjectTypeId ||
      grant.subjectObjectTypeId !== targetObjectTypeId
    ) {
      throw invalid(
        `Share '${share.id}' Action '${grant.actionId}' must be defined exactly on '${targetObjectTypeId}'. Shared Actions do not inherit in V1.`
      )
    }
    assertShareableActionParams({
      ontology: input.ontology,
      params: action.params,
      shareId: share.id,
      actionId: action.id,
    })
    grants.push({
      kind: "action.apply",
      actionId: action.id,
      subjects: [{ ...input.target }],
    })
  }

  return snapshotRuntimeAccessPlan({ grants })
}

const SHAREABLE_PRIMITIVE_SCHEMAS = new Set([
  "string",
  "integer",
  "double",
  "decimal",
  "boolean",
  "date",
  "timestamp",
  "uuid",
])

/**
 * V1 deliberately excludes references from shared Action params. A delegated caller cannot yet be
 * authorized to resolve arbitrary object or blob references supplied at invocation time.
 */
function assertShareableActionParams(input: {
  readonly ontology: OntologyDefinitionCatalog
  readonly params: Readonly<Record<string, { readonly schema: unknown }>>
  readonly shareId: string
  readonly actionId: string
}): void {
  const seenSchemas = new WeakSet<object>()
  const resolvingValueTypes = new Set<string>()

  const reject = (path: string, kind: "objectRef" | "fileRef"): never => {
    throw invalid(
      `Share '${input.shareId}' Action '${input.actionId}' parameter '${path}' uses ${kind}. Shared Action parameters cannot contain objectRef or fileRef in V1.`
    )
  }

  const malformed = (path: string): never => {
    throw invalid(
      `Share '${input.shareId}' Action '${input.actionId}' parameter '${path}' has a schema that cannot be inspected safely.`
    )
  }

  const walk = (schema: unknown, path: string): void => {
    if (typeof schema === "string") {
      if (schema === "fileRef") reject(path, "fileRef")
      if (!SHAREABLE_PRIMITIVE_SCHEMAS.has(schema)) malformed(path)
      return
    }
    if (!isRecord(schema)) throw malformed(path)
    if (seenSchemas.has(schema)) return
    seenSchemas.add(schema)

    switch (schema.type) {
      case "objectRef":
        reject(path, "objectRef")
        break
      case "enum":
        return
      case "object": {
        if (!isRecord(schema.properties)) throw malformed(path)
        for (const [fieldId, field] of Object.entries(schema.properties)) {
          if (!isRecord(field) || !("schema" in field)) {
            throw malformed(`${path}.${fieldId}`)
          }
          walk(field.schema, `${path}.${fieldId}`)
        }
        return
      }
      case "array":
        if (!("items" in schema)) throw malformed(path)
        walk(schema.items, `${path}[]`)
        return
      case "map":
        if (!("valueSchema" in schema)) throw malformed(path)
        walk(schema.valueSchema, `${path}{}`)
        return
      case "valueTypeRef": {
        if (typeof schema.valueTypeId !== "string" || !schema.valueTypeId.trim()) {
          throw malformed(path)
        }
        const valueTypeId = schema.valueTypeId
        if (resolvingValueTypes.has(valueTypeId)) {
          // Recursive inline resolutions are still untrusted. Inspect one when present; the
          // schema-identity guard terminates honest self-reference while catching a forged second
          // resolution that hides a reference-bearing payload behind the same id.
          if (schema._resolved !== undefined) {
            walk(schema._resolved, `${path}<${valueTypeId}>`)
          }
          return
        }
        // The registered ValueType is authoritative. `_resolved` supports inference and
        // auto-registration; it must not override the current ontology under the same id.
        const resolved =
          input.ontology.getValueTypesById().get(valueTypeId)?.schema ?? schema._resolved
        if (resolved === undefined) {
          throw invalid(
            `Share '${input.shareId}' Action '${input.actionId}' parameter '${path}' references unknown ValueType '${valueTypeId}', so it cannot be inspected safely.`
          )
        }
        resolvingValueTypes.add(valueTypeId)
        try {
          walk(resolved, `${path}<${valueTypeId}>`)
        } finally {
          resolvingValueTypes.delete(valueTypeId)
        }
        return
      }
      default:
        throw malformed(path)
    }
  }

  for (const [paramId, param] of Object.entries(input.params)) {
    if (!isRecord(param) || !("schema" in param)) throw malformed(paramId)
    walk(param.schema, paramId)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function compileNode(
  ontology: OntologyDefinitionCatalog,
  authoredObjectTypeIds: readonly string[],
  links: LinkPathSelectionMode,
  shareId: string
): ObjectReadNode {
  const objectTypeIds = uniqueSorted(authoredObjectTypeIds)
  const objectTypes = objectTypeIds.map((id) => ontology.resolveObjectType(id))
  const objects: ObjectReadObjectSelection[] = objectTypes.map((objectType) => ({
    objectTypeId: objectType.id,
    propertyIds: uniqueSorted(objectType.properties.map((property) => property.id)),
  }))

  const selectedLinks =
    links.kind === "none"
      ? []
      : links.kind === "all"
        ? allDirectLinks(ontology, objectTypes)
        : links.links

  const compiledLinks = selectedLinks.map((selection) =>
    compileLinkSelection({ ontology, parentObjectTypeIds: objectTypeIds, selection, shareId })
  )

  return { objects, links: compiledLinks }
}

function allDirectLinks(
  ontology: OntologyDefinitionCatalog,
  objectTypes: readonly ObjectType[]
): readonly LinkPathSelection[] {
  const selections: LinkPathSelection[] = []
  const sortedObjectTypes = [...objectTypes].sort((a, b) => a.id.localeCompare(b.id))
  const descendantIdsByType = new Map(
    sortedObjectTypes.map((objectType) => [
      objectType.id,
      new Set(ontology.listSubTypes(objectType.id)),
    ])
  )

  for (const objectType of sortedObjectTypes) {
    for (const link of [...objectType.links].sort((a, b) => a.id.localeCompare(b.id))) {
      const inheritedSelectionAlreadyCoversLink = sortedObjectTypes.some(
        (candidate) =>
          candidate.id !== objectType.id &&
          descendantIdsByType.get(candidate.id)?.has(objectType.id) === true &&
          candidate.links.some((candidateLink) => candidateLink.id === link.id)
      )
      if (inheritedSelectionAlreadyCoversLink) continue
      selections.push({
        kind: "linkPathSelection",
        sourceObjectTypeId: objectType.id,
        linkId: link.id,
        targetObjectTypeId: link.targetObjectTypeId,
        selection: { kind: "none" },
      })
    }
  }
  return selections
}

function compileLinkSelection(input: {
  readonly ontology: OntologyDefinitionCatalog
  readonly parentObjectTypeIds: readonly string[]
  readonly selection: LinkPathSelection
  readonly shareId: string
}): ObjectReadLinkSelection {
  const selectorSource = input.ontology.getObjectTypeById(input.selection.sourceObjectTypeId)
  if (!selectorSource) {
    throw invalid(
      `Share '${input.shareId}' selects link '${input.selection.sourceObjectTypeId}.${input.selection.linkId}' on an unknown object type.`
    )
  }
  const eligibleSourceIds = new Set([
    selectorSource.id,
    ...input.ontology.listSubTypes(selectorSource.id),
  ])
  const definitions: ObjectReadLinkDefinitionSelection[] = []
  const targetObjectTypeIds = new Set<string>()

  for (const sourceObjectTypeId of input.parentObjectTypeIds) {
    if (!eligibleSourceIds.has(sourceObjectTypeId)) continue
    const source = input.ontology.resolveObjectType(sourceObjectTypeId)
    const link = source.links.find((candidate) => candidate.id === input.selection.linkId)
    if (!link) continue
    const concreteTargetIds = expandLinkTargets(input.ontology, link, input.shareId, source.id)
    for (const id of concreteTargetIds) targetObjectTypeIds.add(id)
    definitions.push({
      sourceObjectTypeId: source.id,
      linkId: link.id,
      targetObjectTypeIds: concreteTargetIds,
      propertyIds: uniqueSorted((link.properties ?? []).map((property) => property.id)),
    })
  }

  if (definitions.length === 0) {
    throw invalid(
      `Share '${input.shareId}' link '${input.selection.sourceObjectTypeId}.${input.selection.linkId}' is not available at this path.`
    )
  }

  return {
    definitions: definitions.sort(compareLinkDefinitions),
    target: compileNode(
      input.ontology,
      [...targetObjectTypeIds],
      input.selection.selection,
      input.shareId
    ),
  }
}

function expandLinkTargets(
  ontology: OntologyDefinitionCatalog,
  link: ObjectLink,
  shareId: string,
  sourceObjectTypeId: string
): readonly string[] {
  if (link.targetObjectTypeId === "*") {
    return uniqueSorted(ontology.listObjectTypes().map((objectType) => objectType.id))
  }
  const authoredIds = Array.isArray(link.targetObjectTypeId)
    ? link.targetObjectTypeId
    : [link.targetObjectTypeId]
  const result: string[] = []
  for (const objectTypeId of authoredIds) {
    if (!ontology.getObjectTypeById(objectTypeId)) {
      throw invalid(
        `Share '${shareId}' link '${sourceObjectTypeId}.${link.id}' targets unknown object type '${objectTypeId}'.`
      )
    }
    result.push(objectTypeId, ...ontology.listSubTypes(objectTypeId))
  }
  return uniqueSorted(result)
}

function compareLinkDefinitions(
  left: ObjectReadLinkDefinitionSelection,
  right: ObjectReadLinkDefinitionSelection
): number {
  return (
    left.sourceObjectTypeId.localeCompare(right.sourceObjectTypeId) ||
    left.linkId.localeCompare(right.linkId)
  )
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function invalid(message: string): ShareDefinitionError {
  return new ShareDefinitionError(`[Sixb] ${message}`)
}
