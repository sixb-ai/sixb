import type { ObjectType } from "../ontology"
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
import type { ActionDefinition } from "./types"

export interface ActionsRuntime {
  list(): readonly ActionDefinition[]
  getById(actionId: string): ActionDefinition | null
  listGlobal(): readonly ActionDefinition[]
  listForType(objectType: ObjectType): readonly ActionDefinition[]
  request(input: RequestActionInput): Promise<RequestActionResult>
  waitFor(input: WaitForActionRunInput): Promise<ActionRunRecord>
  requestAndWait(input: RequestActionAndWaitInput): Promise<ActionRunRecord>
}

/** Compose the Action catalog and run-request API from the domain-owned registry. */
export function createActionsRuntime(runtime: SixbRuntimeContext): ActionsRuntime {
  return {
    list: () => runtime.actionRegistry.list(),
    getById: (actionId) => runtime.actionRegistry.getById(actionId),
    listGlobal: () => runtime.actionRegistry.getGlobalActions(),
    listForType: (objectType) => runtime.actionRegistry.getActionsForType(objectType),
    request: (input) => requestAction(runtime, input),
    waitFor: (input) => waitForActionRun(runtime, input),
    requestAndWait: (input) => requestActionAndWait(runtime, input),
  }
}
