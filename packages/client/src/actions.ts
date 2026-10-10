import type { GetActionRunResponse } from "./generated/types.gen"

/** An Action run as the API returns it: recorded once, when it ended. */
export type ActionRunDetail = GetActionRunResponse

type FailedActionRunDetail = ActionRunDetail & { readonly status: "failed" }

/** An Action run that finished without succeeding. `run` is its terminal record. */
export class ActionRunFailedError extends Error {
  readonly name = "ActionRunFailedError"
  readonly run: ActionRunDetail
  readonly runId: string
  readonly actionId: string
  readonly status: "failed"
  readonly subject: ActionRunDetail["subject"]
  readonly error: ActionRunDetail["error"]

  constructor(run: FailedActionRunDetail) {
    super(run.error?.message ?? `Action run '${run.id}' failed.`)
    this.run = run
    this.runId = run.id
    this.actionId = run.actionId
    this.status = run.status
    this.subject = run.subject
    this.error = run.error
  }
}

export function isFailedActionRun(run: ActionRunDetail): run is FailedActionRunDetail {
  return run.status === "failed"
}
