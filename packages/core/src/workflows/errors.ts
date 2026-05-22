export class WorkflowDefinitionError extends Error {
  readonly name = "WorkflowDefinitionError"
}

export class WorkflowValidationError extends Error {
  readonly name = "WorkflowValidationError"
  override readonly cause?: unknown

  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message)
    this.cause = options?.cause
  }
}
