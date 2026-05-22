import type { ActionRunFailure } from "../../storage"

export class ActionValidationError extends Error {
  readonly name = "ActionValidationError"
  readonly actionId: string
  readonly primaryId: string

  constructor(message: string, params: { actionId: string; primaryId: string }) {
    super(message)
    this.actionId = params.actionId
    this.primaryId = params.primaryId
  }
}

export class ActionRunFailedError extends Error {
  readonly name = "ActionRunFailedError"
  readonly runId: string
  readonly actionId: string
  readonly objectTypeId: string
  readonly primaryId: string
  readonly error: ActionRunFailure
  readonly finishedAt: string

  constructor(payload: {
    runId: string
    actionId: string
    objectTypeId: string
    primaryId: string
    error: ActionRunFailure
    finishedAt: string
  }) {
    super(payload.error.message)
    this.runId = payload.runId
    this.actionId = payload.actionId
    this.objectTypeId = payload.objectTypeId
    this.primaryId = payload.primaryId
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
