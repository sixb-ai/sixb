import type { ParioRuntimeContext } from "../runtime/types"
import {
  type RequestActionAndWaitInput,
  type RequestActionInput,
  requestAction,
  requestActionAndWait,
} from "./request"

export class ActionsRuntime {
  private readonly runtime: ParioRuntimeContext

  constructor(runtime: ParioRuntimeContext) {
    this.runtime = runtime
  }

  request(input: RequestActionInput): Promise<{ runId: string }> {
    return requestAction(this.runtime, input)
  }

  requestAndWait(input: RequestActionAndWaitInput): Promise<{ runId: string }> {
    return requestActionAndWait(this.runtime, input)
  }
}
