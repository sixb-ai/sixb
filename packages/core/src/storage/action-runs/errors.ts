import { MaterializationConflictError } from "../../materialization/errors"

/**
 * Base error for action-run storage operations. Callers can use this to catch
 * domain-specific failures without relying on message text.
 */
export class ActionRunError extends MaterializationConflictError {
  readonly name = "ActionRunError"

  constructor(message: string) {
    super("run-correlation", message)
  }
}
