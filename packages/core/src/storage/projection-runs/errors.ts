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

/** A delivery found its run held by a live execution, whose lease lasts until `ownedUntil`. */
export class ProjectionRunHeldError extends ProjectionRunError {
  constructor(
    readonly runId: string,
    readonly ownedUntil: Date
  ) {
    super(`[Sixb] Projection run '${runId}' is still held by another delivery.`)
  }
}
