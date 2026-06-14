import type { SixbRuntimeContext } from "../runtime/types"
import type { ActionRunRecord } from "../storage"
import {
  type RequestActionAndWaitInput,
  type RequestActionInput,
  type RequestActionResult,
  requestAction,
  requestActionAndWait,
  type WaitForActionRunInput,
  waitForActionRun,
} from "./request"

export class ActionsRuntime {
  private readonly runtime: SixbRuntimeContext

  constructor(runtime: SixbRuntimeContext) {
    this.runtime = runtime
  }

  request(input: RequestActionInput): Promise<RequestActionResult> {
    return requestAction(this.runtime, input)
  }

  waitFor(input: WaitForActionRunInput): Promise<ActionRunRecord> {
    return waitForActionRun(this.runtime, input)
  }

  requestAndWait(input: RequestActionAndWaitInput): Promise<ActionRunRecord> {
    return requestActionAndWait(this.runtime, input)
  }
}
