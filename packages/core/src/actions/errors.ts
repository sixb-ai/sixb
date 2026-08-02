import { SixbError, type SixbErrorOptions, SixbValidationError } from "../errors"

/** The app's `action(...)` declaration is wrong. */
export class ActionDefinitionError extends SixbValidationError {
  override readonly name = "ActionDefinitionError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("runtime.invalid_definition", message, options)
  }
}

/** The action ran, and committing what it produced did not. */
export class ActionEditCommitError extends SixbError {
  override readonly name = "ActionEditCommitError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("action.commit_failed", message, options)
  }
}

export function missingActionMutationMessage(actionId: string): string {
  return `Action "${actionId}" must declare .writeback(...) or .edits(...).`
}

export function effectsWithoutEditsMessage(actionId: string): string {
  return `Action "${actionId}" cannot declare .effects(...) without .edits(...).`
}
