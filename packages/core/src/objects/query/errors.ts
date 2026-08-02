import { SixbError, type SixbErrorOptions, SixbValidationError } from "../../errors"
import type { ObjectQueryValidationIssue } from "./validate"

export interface ObjectQueryPlanningIssue {
  path: string
  code: string
  message: string
}

export class ObjectQueryValidationError extends SixbValidationError {
  override readonly name = "ObjectQueryValidationError"
  readonly issues: readonly ObjectQueryValidationIssue[]

  // `issues` stays on the class and out of `details`: the message already names every one of them,
  // the route that answers a query serializes them in full, and the failure record's details are
  // flat scalars for a reader, not a second copy of a typed field.
  constructor(issues: readonly ObjectQueryValidationIssue[]) {
    super("storage.query_invalid", formatQueryValidationMessage(issues))
    this.issues = issues
  }
}

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

export class ObjectQueryExecutionError extends SixbError {
  override readonly name = "ObjectQueryExecutionError"
  /** The planner's own finer discriminant, e.g. `fallback_row_limit_exceeded`. */
  readonly reason: string
  readonly path?: string

  constructor(
    code: ObjectQueryExecutionErrorCode,
    reason: string,
    message: string,
    path?: string,
    options?: SixbErrorOptions
  ) {
    super(code, `[Sixb] Object query execution failed: ${message}`, {
      ...options,
      details: { reason, ...(path ? { path } : {}), ...options?.details },
    })
    this.reason = reason
    this.path = path
  }
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
