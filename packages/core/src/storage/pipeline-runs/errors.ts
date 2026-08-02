import { SixbError, type SixbErrorOptions } from "../../errors"

/** Pipeline-run storage refusing a read or a write. See {@link WorkflowRunError} on the code. */
export type PipelineRunErrorCode =
  | "pipeline.run_not_found"
  | "storage.conflict"
  | "runtime.invalid_input"

export class PipelineRunError extends SixbError {
  override readonly name = "PipelineRunError"

  // biome-ignore lint/complexity/noUselessConstructor: it narrows `code` to this store's set.
  constructor(code: PipelineRunErrorCode, message: string, options?: SixbErrorOptions) {
    super(code, message, options)
  }
}
