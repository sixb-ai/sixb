import { type SixbErrorOptions, SixbValidationError } from "../errors"

/** The app's `defineWorkflow(...)` call is wrong; nothing about the request can fix it. */
export class WorkflowDefinitionError extends SixbValidationError {
  override readonly name = "WorkflowDefinitionError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("runtime.invalid_definition", message, options)
  }
}

/** The value handed to a workflow does not match what the workflow declared. */
export class WorkflowValidationError extends SixbValidationError {
  override readonly name = "WorkflowValidationError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("runtime.invalid_input", message, options)
  }
}
