import { isSixbError, SixbError, type SixbErrorOptions, toSixbFailure } from "../../errors"
import type { ObjectQueryValidationIssue } from "./validate"

export interface ObjectQueryPlanningIssue {
  path: string
  code: string
  message: string
}

/** What the query routes answer next to the error body. Same shape as the OpenAPI component. */
export interface ObjectQueryIssue {
  readonly path: string
  readonly code: string
  readonly message: string
}

/**
 * One of the two classes the query layer still needs, and the only reason either exists: `issues` is
 * a **list of objects**, while `SixbFailureDetails` is flat scalars by design, so the list cannot
 * ride in the failure record. It does not belong there either — it is a sibling field of the query
 * response, which is the only place it has ever been read.
 *
 * Nothing branches on the class. Read it with {@link objectQueryIssues}, which matches on `code` and
 * checks the shape, so it keeps working for a failure that crossed a bundle boundary between two
 * copies of the runtime — the one thing `instanceof` cannot do.
 */
export class ObjectQueryValidationError extends SixbError {
  override readonly name = "ObjectQueryValidationError"
  readonly issues: readonly ObjectQueryValidationIssue[]

  constructor(issues: readonly ObjectQueryValidationIssue[]) {
    super("storage.query_invalid", formatQueryValidationMessage(issues))
    this.issues = issues
  }
}

/** The store cannot run this query at all. Carries `issues` for the same reason. */
export class ObjectQueryPlanningError extends SixbError {
  override readonly name = "ObjectQueryPlanningError"
  readonly issues: readonly ObjectQueryPlanningIssue[]

  constructor(issues: readonly ObjectQueryPlanningIssue[]) {
    super("storage.query_unsupported", formatQueryPlanningMessage(issues))
    this.issues = issues
  }
}

/**
 * Either the query cannot be run as written, or the store cannot run it at all. Both answer 400 and
 * a caller acts on them differently: drop the bad page token, or narrow the query.
 */
export type ObjectQueryExecutionErrorCode = "storage.query_invalid" | "storage.query_unsupported"

/**
 * A single-fault execution failure, raised by the store compilers and the fallback engine.
 *
 * Unlike the two carriers above this needs no class: `reason` — the planner's own finer discriminant,
 * e.g. `fallback_row_limit_exceeded` — and `path` are scalars, so they live in `details` and
 * {@link objectQueryIssues} rebuilds the one-element issue list from them.
 */
export function objectQueryExecutionFailed(
  code: ObjectQueryExecutionErrorCode,
  reason: string,
  message: string,
  path?: string,
  options?: SixbErrorOptions
): SixbError {
  return new SixbError(code, `[Sixb] Object query execution failed: ${message}`, {
    ...options,
    details: { reason, ...(path ? { path } : {}), ...options?.details },
  })
}

/**
 * The issue list a query failure should be answered with, or `undefined` when it is not one.
 *
 * One reader for both shapes: a carrier hands over its list, and a single-fault execution failure has
 * its issue rebuilt from `details`. That is why the query route has one branch instead of three.
 */
export function objectQueryIssues(error: unknown): readonly ObjectQueryIssue[] | undefined {
  if (
    !isSixbError(error, "storage.query_invalid") &&
    !isSixbError(error, "storage.query_unsupported")
  ) {
    return undefined
  }

  const carried = (error as { readonly issues?: unknown }).issues
  if (Array.isArray(carried) && carried.every(isObjectQueryIssue)) {
    return carried
  }

  const { details } = toSixbFailure(error)
  const reason = details?.reason
  if (typeof reason !== "string") return undefined
  const path = details?.path
  // The issue keeps the planner's own discriminant; the error's `code` is the framework-wide one.
  return [{ path: typeof path === "string" ? path : "$", code: reason, message: error.message }]
}

function isObjectQueryIssue(value: unknown): value is ObjectQueryIssue {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<ObjectQueryIssue>
  return (
    typeof candidate.path === "string" &&
    typeof candidate.code === "string" &&
    typeof candidate.message === "string"
  )
}

function formatQueryValidationMessage(issues: readonly ObjectQueryValidationIssue[]): string {
  if (issues.length === 0) return "[Sixb] Object query validation failed"
  if (issues.length === 1) return `[Sixb] Object query validation failed: ${issues[0].message}`
  return `[Sixb] Object query validation failed with ${issues.length} issues: ${issues
    .map((issue) => issue.message)
    .join("; ")}`
}

function formatQueryPlanningMessage(issues: readonly ObjectQueryPlanningIssue[]): string {
  if (issues.length === 0) return "[Sixb] Object query planning failed"
  if (issues.length === 1) return `[Sixb] Object query planning failed: ${issues[0].message}`
  return `[Sixb] Object query planning failed with ${issues.length} issues: ${issues
    .map((issue) => issue.message)
    .join("; ")}`
}
