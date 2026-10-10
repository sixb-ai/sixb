import type { GetActionRunResponse } from "./generated/types.gen"

/** An Action run as the API returns it: finished from `requestAction`, as stored otherwise. */
export type ActionRunDetail = GetActionRunResponse
export type ActionRunTerminalFailureStatus = Extract<
  ActionRunDetail["status"],
  "failed" | "cancelled"
>

/** An Action run that finished without succeeding. `run` is its terminal record. */
export class ActionRunFailedError extends Error {
  readonly name = "ActionRunFailedError"
  readonly run: ActionRunDetail
  readonly runId: string
  readonly actionId: string
  readonly status: ActionRunTerminalFailureStatus
  readonly subject: ActionRunDetail["subject"]
  readonly error: ActionRunDetail["error"]

  constructor(run: ActionRunDetail & { readonly status: ActionRunTerminalFailureStatus }) {
    super(run.error?.message ?? `Action run '${run.id}' finished with status '${run.status}'.`)
    this.run = run
    this.runId = run.id
    this.actionId = run.actionId
    this.status = run.status
    this.subject = run.subject
    this.error = run.error
  }
}

export function isFailedActionRun(
  run: ActionRunDetail
): run is ActionRunDetail & { readonly status: ActionRunTerminalFailureStatus } {
  return run.status === "failed" || run.status === "cancelled"
}
