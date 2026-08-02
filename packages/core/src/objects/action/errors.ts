import type { ActionSubject } from "../../actions"
import { SixbError, SixbTimeoutError, SixbValidationError } from "../../errors"
import type { ActionRunFailure } from "../../storage"

function subjectDetails(subject: ActionSubject): Record<string, string> {
  return subject.kind === "object"
    ? { objectTypeId: subject.objectTypeId, primaryId: subject.primaryId }
    : {}
}

export class ActionValidationError extends SixbValidationError {
  override readonly name = "ActionValidationError"
  readonly actionId: string
  readonly subject: ActionSubject
  readonly primaryId?: string

  constructor(message: string, params: { actionId: string; subject: ActionSubject }) {
    super("runtime.invalid_input", message, {
      details: { actionId: params.actionId, ...subjectDetails(params.subject) },
    })
    this.actionId = params.actionId
    this.subject = params.subject
    this.primaryId = params.subject.kind === "object" ? params.subject.primaryId : undefined
  }
}

export class ActionRunFailedError extends SixbError {
  override readonly name = "ActionRunFailedError"
  readonly runId: string
  readonly actionId: string
  readonly subject: ActionSubject
  readonly objectTypeId?: string
  readonly primaryId?: string
  readonly error: ActionRunFailure
  readonly finishedAt: string

  constructor(payload: {
    runId: string
    actionId: string
    subject: ActionSubject
    error: ActionRunFailure
    finishedAt: string
  }) {
    super("action.failed", payload.error.message, {
      details: {
        runId: payload.runId,
        actionId: payload.actionId,
        ...subjectDetails(payload.subject),
      },
    })
    this.runId = payload.runId
    this.actionId = payload.actionId
    this.subject = payload.subject
    this.objectTypeId = payload.subject.kind === "object" ? payload.subject.objectTypeId : undefined
    this.primaryId = payload.subject.kind === "object" ? payload.subject.primaryId : undefined
    this.error = payload.error
    this.finishedAt = payload.finishedAt
  }
}

export class ActionRunTimeoutError extends SixbTimeoutError {
  override readonly name = "ActionRunTimeoutError"
  readonly runId: string
  readonly timeoutMs: number

  constructor(params: { runId: string; timeoutMs: number }) {
    super(
      "action.timed_out",
      `Action run '${params.runId}' did not finish within ${params.timeoutMs}ms.`,
      { details: { runId: params.runId, timeoutMs: params.timeoutMs } }
    )
    this.runId = params.runId
    this.timeoutMs = params.timeoutMs
  }
}
