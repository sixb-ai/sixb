import { canViewActionRun, isAllowed } from "../authorization"
import type { ObjectType } from "../ontology"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  ActionRunRecord,
  ListActionRunsInput,
  ListActionRunsResult,
} from "../storage/action-runs"
import {
  type RequestActionAndWaitInput,
  type RequestActionInput,
  type RequestActionResult,
  requestAction,
  requestActionAndWait,
} from "./request"
import type { ActionDefinition } from "./types"

export interface ExecutionActionRunsRuntime {
  getById(runId: string): Promise<ActionRunRecord | null>
  list(
    input?: Omit<ListActionRunsInput, "projectId" | "actionIds" | "objectTypeIds">
  ): Promise<ListActionRunsResult>
}

export interface ExecutionActionsRuntime {
  list(): readonly ActionDefinition[]
  getById(actionId: string): ActionDefinition | null
  listGlobal(): readonly ActionDefinition[]
  listForType(objectType: ObjectType): readonly ActionDefinition[]
  request(input: RequestActionInput): Promise<RequestActionResult>
  requestAndWait(input: RequestActionAndWaitInput): Promise<ActionRunRecord>
  readonly runs: ExecutionActionRunsRuntime
}

export function createExecutionActionsRuntime(
  runtime: SixbRuntimeContext
): ExecutionActionsRuntime {
  const canList = (action: ActionDefinition) =>
    isAllowed(runtime.authorization, { kind: "action.apply", actionId: action.id }) &&
    (action.binding.kind === "global" ||
      isAllowed(runtime.authorization, {
        kind: "object.view",
        objectTypeId: action.binding.objectType.id,
      }))

  return {
    list: () => runtime.actionRegistry.list().filter(canList),
    getById: (actionId) => {
      const action = runtime.actionRegistry.getById(actionId)
      return action && canList(action) ? action : null
    },
    listGlobal: () => runtime.actionRegistry.getGlobalActions().filter(canList),
    listForType: (objectType) =>
      runtime.actionRegistry.getActionsForType(objectType).filter(canList),
    request: (input) => requestAction(runtime, input),
    requestAndWait: (input) => requestActionAndWait(runtime, input),
    runs: {
      getById: async (runId) => {
        const run =
          (await runtime.storage.actionRuns?.getById({
            projectId: runtime.projectId,
            id: runId,
          })) ?? null
        return run && canViewActionRun(runtime.authorization, run) ? run : null
      },
      list: (input = {}) => {
        const storage = runtime.storage.actionRuns
        if (!storage) return Promise.resolve({ runs: [], hasMore: false, total: 0 })
        return storage.list({
          projectId: runtime.projectId,
          ...input,
          actionIds: runtime.authorization
            ? [...runtime.authorization.grants["apply:action"]]
            : undefined,
          objectTypeIds: runtime.authorization
            ? [...runtime.authorization.grants["view:object"]]
            : undefined,
        })
      },
    },
  }
}
