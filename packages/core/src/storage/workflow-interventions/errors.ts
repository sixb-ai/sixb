import { SixbError, type SixbErrorOptions } from "../../errors"

/** Workflow-intervention storage refusing a read or a write. */
export type WorkflowInterventionErrorCode =
  | "workflow.intervention_not_found"
  | "storage.conflict"
  | "runtime.invalid_input"

export class WorkflowInterventionError extends SixbError {
  override readonly name = "WorkflowInterventionError"

  // biome-ignore lint/complexity/noUselessConstructor: it narrows `code` to this store's set.
  constructor(code: WorkflowInterventionErrorCode, message: string, options?: SixbErrorOptions) {
    super(code, message, options)
  }
}
