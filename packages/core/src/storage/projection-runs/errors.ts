import {
  MaterializationConflictError,
  type MaterializationConflictKind,
} from "../../materialization/errors"

/**
 * Base error for projection-run storage operations.
 */
export class ProjectionRunError extends MaterializationConflictError {
  readonly name = "ProjectionRunError"

  constructor(message: string, kind: MaterializationConflictKind = "run-correlation") {
    super(kind, message)
  }
}
