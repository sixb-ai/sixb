import { SixbError, type SixbErrorOptions } from "../../errors"

/**
 * Workflow-run storage refusing a read or a write.
 *
 * The code is a parameter rather than fixed by the class, because the same store answers three
 * different questions wrong: a run that is not there (404), a run whose state or execution token
 * refuses the write (409), and a row that does not describe a workflow this project has (400).
 * Filing all three under one code is what made every one of them a 400 with nothing to branch on.
 */
export type WorkflowRunErrorCode =
  | "workflow.run_not_found"
  | "workflow.node_run_not_found"
  | "workflow.agent_execution_not_found"
  | "workflow.run_conflict"
  | "runtime.invalid_input"

export class WorkflowRunError extends SixbError {
  override readonly name = "WorkflowRunError"

  // biome-ignore lint/complexity/noUselessConstructor: it narrows `code` to this store's set.
  constructor(code: WorkflowRunErrorCode, message: string, options?: SixbErrorOptions) {
    super(code, message, options)
  }
}
