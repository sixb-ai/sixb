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

interface CapturedViewGrant {
  readonly kind: "object.view"
  readonly rootStart: number
  readonly rootCount: number
}

type CapturedGrant = CapturedViewGrant | ShareScopedActionGrant

interface ActionCaptureBudget {
  subjectCount: number
  identifierCharacters: number
}

/** Validate and detach an access plan before registering process-local authority. */
export function snapshotShareAccessPlan(input: ShareAccessPlan): ShareAccessPlan {
  const captured = captureAccessPlanGrants(input)
  const selection = validateMergedViewSelection(captured.viewRoots)
  return assembleAccessPlanSnapshot(captured.grants, selection)
}

function captureAccessPlanGrants(input: ShareAccessPlan): {
  readonly grants: readonly CapturedGrant[]
  readonly viewRoots: readonly ObjectReadRoot[]
} {
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

  // Share budgets across grants and capture caller-controlled fields exactly once.
  const budget: ActionCaptureBudget = { subjectCount: 0, identifierCharacters: 0 }
  const viewRoots: ObjectReadRoot[] = []
  const grants: CapturedGrant[] = []
  for (let index = 0; index < grantCount; index += 1) {
    const grant = authoredGrants[index]
    if (!isRecord(grant)) {
      throw new Error(`[Sixb] Scoped grant ${index} must be an object.`)
    }
    const kind = grant.kind
    switch (kind) {
      case "object.view":
        grants.push(captureViewGrant(grant, index, viewRoots))
        break
      case "action.apply":
        grants.push(captureActionGrant(grant, index, budget))
        break
      default:
        throw new Error(`[Sixb] Unknown scoped grant kind '${String(kind)}'.`)
    }
  }
  return { grants, viewRoots }
}

function captureViewGrant(
  grant: Record<string, unknown>,
  index: number,
  viewRoots: ObjectReadRoot[]
): CapturedViewGrant {
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
  if (rootCount > MAX_SCOPED_VIEW_ROOTS_BEFORE_COMPILATION - viewRoots.length) {
    throw new Error(
      `[Sixb] Share access plan exceeds the maximum of ${MAX_SCOPED_VIEW_ROOTS_BEFORE_COMPILATION} raw scoped view roots.`
    )
  }
  const rootStart = viewRoots.length
  for (let rootIndex = 0; rootIndex < rootCount; rootIndex += 1) {
    viewRoots.push(roots[rootIndex] as ObjectReadRoot)
  }
  return { kind: "object.view", rootStart, rootCount }
}

function captureActionGrant(
  grant: Record<string, unknown>,
  index: number,
  budget: ActionCaptureBudget
): ShareScopedActionGrant {
  const authoredActionId = grant.actionId
  const authoredSubjects = grant.subjects
  const actionId = nonEmpty(authoredActionId, `Scoped grant ${index} action id`)
  addActionIdentifierCharacters(budget, actionId.length)
  if (!Array.isArray(authoredSubjects)) {
    throw new Error(`[Sixb] Scoped grant ${index} action subjects must be an array.`)
  }
  const subjectCount = authoredSubjects.length
  budget.subjectCount += subjectCount
  if (budget.subjectCount > MAX_SCOPED_ACTION_SUBJECTS) {
    throw new Error(
      `[Sixb] Share access plan exceeds the maximum of ${MAX_SCOPED_ACTION_SUBJECTS} scoped action subjects.`
    )
  }
  const subjects: ObjectRef[] = []
  for (let subjectIndex = 0; subjectIndex < subjectCount; subjectIndex += 1) {
    const subject = captureActionSubject(authoredSubjects[subjectIndex], index, subjectIndex)
    addActionIdentifierCharacters(budget, subject.objectTypeId.length + subject.primaryId.length)
    subjects.push(subject)
  }
  return Object.freeze({ kind: "action.apply", actionId, subjects: Object.freeze(subjects) })
}

function captureActionSubject(
  subject: unknown,
  grantIndex: number,
  subjectIndex: number
): ObjectRef {
  if (!isRecord(subject)) {
    throw new Error(`[Sixb] Scoped grant ${grantIndex} subject ${subjectIndex} must be an object.`)
  }
  const authoredObjectTypeId = subject.objectTypeId
  const authoredPrimaryId = subject.primaryId
  const objectTypeId = nonEmpty(
    authoredObjectTypeId,
    `Scoped grant ${grantIndex} subject ${subjectIndex} object type id`
  )
  const primaryId = nonEmpty(
    authoredPrimaryId,
    `Scoped grant ${grantIndex} subject ${subjectIndex} primary id`
  )
  return Object.freeze({ objectTypeId, primaryId })
}

function addActionIdentifierCharacters(budget: ActionCaptureBudget, count: number): void {
  budget.identifierCharacters += count
  if (budget.identifierCharacters > MAX_SCOPED_ACTION_IDENTIFIER_CHARACTERS) {
    throw new Error(
      `[Sixb] Share access plan exceeds the maximum of ${MAX_SCOPED_ACTION_IDENTIFIER_CHARACTERS} scoped action identifier characters.`
    )
  }
}

function validateMergedViewSelection(roots: readonly ObjectReadRoot[]): SelectedObjectReadScope {
  // Snapshot all roots together so the provider's limits apply globally across view grants.
  const selection = captureSelectedObjectReadScope({ kind: "selected", roots })
  // Compile the exact immutable snapshot, without rereading caller-controlled data.
  compileSelectedObjectReadScope(selection)
  return selection
}

function assembleAccessPlanSnapshot(
  capturedGrants: readonly CapturedGrant[],
  selection: SelectedObjectReadScope
): ShareAccessPlan {
  const grants = capturedGrants.map((grant): ShareScopedGrant => {
    if (grant.kind === "action.apply") return grant
    const roots = Object.freeze(
      selection.roots.slice(grant.rootStart, grant.rootStart + grant.rootCount)
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
