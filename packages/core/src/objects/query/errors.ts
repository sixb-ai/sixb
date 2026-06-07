import type { ObjectQueryValidationIssue } from "./validate"

export interface ObjectQueryPlanningIssue {
  path: string
  code: string
  message: string
}

export class ObjectQueryValidationError extends Error {
  readonly name = "ObjectQueryValidationError"
  readonly issues: readonly ObjectQueryValidationIssue[]

  constructor(issues: readonly ObjectQueryValidationIssue[]) {
    super(formatQueryValidationMessage(issues))
    this.issues = issues
  }
}

export class ObjectQueryPlanningError extends Error {
  readonly name = "ObjectQueryPlanningError"
  readonly issues: readonly ObjectQueryPlanningIssue[]

  constructor(issues: readonly ObjectQueryPlanningIssue[]) {
    super(formatQueryPlanningMessage(issues))
    this.issues = issues
  }
}

export class ObjectQueryExecutionError extends Error {
  readonly name = "ObjectQueryExecutionError"
  readonly code: string
  readonly path?: string

  constructor(code: string, message: string, path?: string) {
    super(`[Sixb] Object query execution failed: ${message}`)
    this.code = code
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
