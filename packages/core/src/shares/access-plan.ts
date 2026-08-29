import type { ObjectRef } from "../ontology"
import {
  captureSelectedObjectReadScope,
  compileSelectedObjectReadScope,
} from "../storage/objects/read-scope"
import type { ObjectReadRoot, SelectedObjectReadScope } from "../storage/objects/types"

const MAX_SCOPED_GRANTS = 1_024
const MAX_SCOPED_VIEW_ROOTS_BEFORE_COMPILATION = 1_024
const MAX_SCOPED_ACTION_SUBJECTS = 4_096
const MAX_SCOPED_ACTION_IDENTIFIER_CHARACTERS = 1_000_000

/** One capability paired with the exact resources it authorizes. */
export type ShareScopedGrant = ShareScopedViewGrant | ShareScopedActionGrant

export interface ShareScopedViewGrant {
  readonly kind: "object.view"
  readonly selection: SelectedObjectReadScope
}

export interface ShareScopedActionGrant {
  readonly kind: "action.apply"
  readonly actionId: string
  readonly subjects: readonly ObjectRef[]
}

/** Internal authority compiled from a delegation such as a shared-access grant. */
export interface ShareAccessPlan {
  readonly grants: readonly ShareScopedGrant[]
}

type CapturedGrant =
  | { readonly kind: "object.view"; readonly rootStart: number; readonly rootCount: number }
  | ShareScopedActionGrant

/** Validate and detach an access plan before registering process-local authority. */
export function snapshotShareAccessPlan(input: ShareAccessPlan): ShareAccessPlan {
  if (!isRecord(input)) {
    throw new Error("[Sixb] Share access plan must contain scoped grants.")
  }
  const authoredGrants = input.grants
  if (!Array.isArray(authoredGrants)) {
    throw new Error("[Sixb] Share access plan must contain scoped grants.")
  }
  const grantCount = authoredGrants.length
  if (grantCount > MAX_SCOPED_GRANTS) {
    throw new Error(
      `[Sixb] Share access plan exceeds the maximum of ${MAX_SCOPED_GRANTS} scoped grants.`
    )
  }

  let actionSubjectCount = 0
  let actionIdentifierCharacters = 0
  const addActionIdentifierCharacters = (count: number): void => {
    actionIdentifierCharacters += count
    if (actionIdentifierCharacters > MAX_SCOPED_ACTION_IDENTIFIER_CHARACTERS) {
      throw new Error(
        `[Sixb] Share access plan exceeds the maximum of ${MAX_SCOPED_ACTION_IDENTIFIER_CHARACTERS} scoped action identifier characters.`
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
          `[Sixb] Share access plan exceeds the maximum of ${MAX_SCOPED_VIEW_ROOTS_BEFORE_COMPILATION} raw scoped view roots.`
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
          `[Sixb] Share access plan exceeds the maximum of ${MAX_SCOPED_ACTION_SUBJECTS} scoped action subjects.`
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

  const mergedSelection = captureSelectedObjectReadScope({
    kind: "selected",
    roots: mergedAuthoredViewRoots,
  })
  // Compile the exact immutable snapshot that will be registered. This verifies normalized shape
  // limits and link/path invariants without a second read of caller-controlled data.
  compileSelectedObjectReadScope(mergedSelection)

  const grants = capturedGrants.map((grant): ShareScopedGrant => {
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

/** Merge view grants only; capability/resource pairing remains intact for every other grant. */
export function objectReadScopeForAccessPlan(plan: ShareAccessPlan): SelectedObjectReadScope {
  return Object.freeze({
    kind: "selected",
    roots: Object.freeze(
      plan.grants.flatMap((grant) =>
        grant.kind === "object.view" ? [...grant.selection.roots] : []
      )
    ),
  })
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
