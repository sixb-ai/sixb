import { MaterializationValidationError } from "../../materialization/errors"
import type { OntologyEditOperation, OntologyOperationOutcome } from "../../materialization/model"
import { linkRefKey, objectRefKey } from "../../materialization/refs"
import type { MaterializationLinkScopeState } from "../../storage/ontology"
import type { MaterializerContext } from "../context"
import { diffEffectiveObject } from "../effective/diff"
import {
  validateEffectiveObject,
  validateLinkAuthorityProperties,
  validateLinkRef,
  validateObjectAuthorityProperties,
  validateObjectPatchPropertyIds,
  validateObjectRef,
} from "../effective/validate"
import type { TimedCommitIdentity } from "../shared/identity"
import { applyLinkEdit, applyObjectEdit } from "./apply"
import { linkCardinality } from "./read-set"
import {
  resolveLink,
  resolveObject,
  validateWorkingCardinality,
  type WorkingLink,
  type WorkingObject,
} from "./working-state"

type ObjectOperation = Extract<OntologyEditOperation, { readonly kind: `object.${string}` }>
type LinkOperation = Extract<OntologyEditOperation, { readonly kind: `link.${string}` }>

/**
 * Transaction-local edit working set.
 *
 * Loaded snapshots remain pinned to the commit start while each successful operation updates the
 * mutable override. Operation N+1 can therefore observe operation N before anything is durable.
 */
export interface EditWorkingState {
  readonly objects: Map<string, WorkingObject>
  readonly links: Map<string, WorkingLink>
  readonly scopeSnapshots: Map<string, MaterializationLinkScopeState>
}

/**
 * Undo record for one override the current operation group replaced.
 *
 * Only the mutable override moves; loaded snapshots stay pinned for the whole commit, so restoring
 * the overrides in reverse returns the working set to its pre-group state. Incident links loaded
 * along the way are a read cache and are deliberately left in place.
 */
interface EditUndoEntry {
  readonly restore: () => void
}

/** Collects undo records while a grouped item applies. */
export type EditUndoJournal = EditUndoEntry[]

export function undoEditJournal(journal: EditUndoJournal): void {
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    journal[index]?.restore()
  }
}

export function applyEditOperation(
  context: MaterializerContext,
  state: EditWorkingState,
  operation: OntologyEditOperation,
  identity: TimedCommitIdentity,
  journal?: EditUndoJournal
): OntologyOperationOutcome {
  validateOperationRef(context, operation)
  if (isObjectOperation(operation)) {
    return applyObjectOperation(context, state, operation, identity, journal)
  }
  return applyLinkOperation(
    context,
    state,
    operation,
    linkCardinality(context.ontology, operation.ref),
    journal
  )
}

function validateOperationRef(
  context: Pick<MaterializerContext, "ontology">,
  operation: OntologyEditOperation
): void {
  if (isObjectOperation(operation)) {
    validateObjectRef(context.ontology, operation.ref)
    return
  }
  validateLinkRef(context.ontology, operation.ref)
}

function applyObjectOperation(
  context: MaterializerContext,
  state: EditWorkingState,
  operation: ObjectOperation,
  identity: TimedCommitIdentity,
  journal?: EditUndoJournal
): OntologyOperationOutcome {
  const working = requireWorkingObject(state, operation)
  const normalized = validateObjectOperation(context, operation)
  const currentEffective = resolveObject(context.ontology, working)
  const transition = applyObjectEdit({
    operation,
    sourceProperties: working.source?.assertion.properties ?? null,
    authority: working.override,
    effectiveExists: currentEffective !== null,
    ...normalized,
  })

  applyObjectTransition(context, state, working, transition.next, journal)

  return objectOperationOutcome(operation, working, transition.changed, context, identity)
}

function requireWorkingObject(state: EditWorkingState, operation: ObjectOperation): WorkingObject {
  const working = state.objects.get(objectRefKey(operation.ref))
  if (!working) throw new MaterializationValidationError("Object state was not loaded.")
  return working
}

function validateObjectOperation(
  context: Pick<MaterializerContext, "ontology">,
  operation: ObjectOperation
): {
  readonly normalizedProperties?: ReturnType<typeof validateObjectAuthorityProperties>
  readonly normalizedSet?: ReturnType<typeof validateObjectAuthorityProperties>
} {
  switch (operation.kind) {
    case "object.create":
    case "object.upsert":
      return {
        normalizedProperties: validateObjectAuthorityProperties(
          context.ontology,
          operation.ref,
          operation.properties
        ),
      }
    case "object.patch":
      validateObjectPatchPropertyIds(context.ontology, operation.ref, operation.unset, "unset")
      validateObjectPatchPropertyIds(context.ontology, operation.ref, operation.reset, "reset")
      return {
        normalizedSet: validateObjectAuthorityProperties(
          context.ontology,
          operation.ref,
          operation.set
        ),
      }
    case "object.delete":
    case "object.restore":
      return {}
  }
}

function applyObjectTransition(
  context: MaterializerContext,
  state: EditWorkingState,
  working: WorkingObject,
  next: WorkingObject["override"],
  journal?: EditUndoJournal
): void {
  const previous = working.override
  working.override = next
  try {
    const resolved = resolveObject(context.ontology, working)
    if (resolved) validateEffectiveObject(context.ontology, resolved.ref, resolved.properties)
    validateWorkingCardinality(context.ontology, state.objects, state.links, state.scopeSnapshots)
  } catch (error) {
    working.override = previous
    throw error
  }
  journal?.push({
    restore: () => {
      working.override = previous
    },
  })
}

function objectOperationOutcome(
  operation: ObjectOperation,
  working: WorkingObject,
  changed: boolean,
  context: Pick<MaterializerContext, "ontology">,
  identity: TimedCommitIdentity
): OntologyOperationOutcome {
  const outcome: OntologyOperationOutcome = {
    id: operation.id,
    ok: true,
    authority: authorityOutcome(changed),
  }
  const resolved = resolveObject(context.ontology, working)
  if (!resolved) return outcome
  const change = diffEffectiveObject({
    before: working.before,
    resolved,
    commitId: identity.commitId,
    committedAt: identity.committedAt,
  })
  const object = change?.after ?? working.before
  if (!object) {
    throw new MaterializationValidationError("Effective object outcome could not be resolved.")
  }
  return { ...outcome, object }
}

function applyLinkOperation(
  context: MaterializerContext,
  state: EditWorkingState,
  operation: LinkOperation,
  cardinality: "one" | "many" | undefined,
  journal?: EditUndoJournal
): OntologyOperationOutcome {
  const working = requireWorkingLink(state, operation)
  validateLinkEndpoints(context, state, operation)
  const normalizedProperties = validateLinkOperation(context, operation)
  const currentEffective = resolveLink(context.ontology, working, state.objects)
  const transitionInput = {
    operation,
    hasSource: working.source !== null,
    authority: working.override,
    effectiveExists: currentEffective !== null,
  }
  const transition = applyLinkEdit({ ...transitionInput, normalizedProperties })
  applyLinkTransition(context, state, working, transition.next, cardinality, journal)
  return { id: operation.id, ok: true, authority: authorityOutcome(transition.changed) }
}

function requireWorkingLink(state: EditWorkingState, operation: LinkOperation): WorkingLink {
  const working = state.links.get(linkRefKey(operation.ref))
  if (!working) throw new MaterializationValidationError("Link state was not loaded.")
  return working
}

function validateLinkEndpoints(
  context: Pick<MaterializerContext, "ontology">,
  state: EditWorkingState,
  operation: LinkOperation
): void {
  if (operation.kind !== "link.upsert") return
  const source = state.objects.get(objectRefKey(operation.ref.source))
  const target = state.objects.get(objectRefKey(operation.ref.target))
  const sourceExists = source && resolveObject(context.ontology, source)
  const targetExists = target && resolveObject(context.ontology, target)
  if (sourceExists && targetExists) return
  throw new MaterializationValidationError("Link upsert requires both endpoints to be effective.")
}

function validateLinkOperation(
  context: Pick<MaterializerContext, "ontology">,
  operation: LinkOperation
): ReturnType<typeof validateLinkAuthorityProperties> | undefined {
  if (operation.kind !== "link.upsert") return undefined
  return validateLinkAuthorityProperties(context.ontology, operation.ref, operation.properties)
}

function applyLinkTransition(
  context: Pick<MaterializerContext, "ontology">,
  state: EditWorkingState,
  working: WorkingLink,
  next: WorkingLink["override"],
  cardinality: "one" | "many" | undefined,
  journal?: EditUndoJournal
): void {
  const previous = working.override
  working.override = next
  try {
    if (cardinality === "one") {
      validateWorkingCardinality(context.ontology, state.objects, state.links, state.scopeSnapshots)
    }
  } catch (error) {
    working.override = previous
    throw error
  }
  journal?.push({
    restore: () => {
      working.override = previous
    },
  })
}

function authorityOutcome(changed: boolean): "changed" | "unchanged" {
  if (changed) return "changed"
  return "unchanged"
}

function isObjectOperation(operation: OntologyEditOperation): operation is ObjectOperation {
  switch (operation.kind) {
    case "object.create":
    case "object.upsert":
    case "object.patch":
    case "object.delete":
    case "object.restore":
      return true
    case "link.upsert":
    case "link.delete":
    case "link.reset":
      return false
  }
}
