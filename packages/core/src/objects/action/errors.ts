import type { ActionSubject } from "../../actions"
import type { ActionRunFailure } from "../../storage"

export class ActionValidationError extends Error {
  readonly name = "ActionValidationError"
  readonly actionId: string
  readonly subject: ActionSubject
  readonly primaryId?: string

  constructor(message: string, params: { actionId: string; subject: ActionSubject }) {
    super(message)
    this.actionId = params.actionId
    this.subject = params.subject
    this.primaryId = params.subject.kind === "object" ? params.subject.primaryId : undefined
  }
}

export class ActionRunFailedError extends Error {
  readonly name = "ActionRunFailedError"
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
    super(payload.error.message)
    this.runId = payload.runId
    this.actionId = payload.actionId
    this.subject = payload.subject
    this.objectTypeId = payload.subject.kind === "object" ? payload.subject.objectTypeId : undefined
    this.primaryId = payload.subject.kind === "object" ? payload.subject.primaryId : undefined
    this.error = payload.error
    this.finishedAt = payload.finishedAt
  }
}

export class ActionRunTimeoutError extends Error {
  readonly name = "ActionRunTimeoutError"
  readonly runId: string
  readonly timeoutMs: number

  constructor(params: { runId: string; timeoutMs: number }) {
    super(`Action run '${params.runId}' did not finish within ${params.timeoutMs}ms.`)
    this.runId = params.runId
    this.timeoutMs = params.timeoutMs
  }
}
