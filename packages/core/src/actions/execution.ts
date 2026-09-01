import { canViewActionRun, isAllowed } from "../authorization"
import type { ExecutionContext } from "../execution"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
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

export interface ActionRunsRuntime {
  getById(runId: string): Promise<ActionRunRecord | null>
  list(
    input?: Omit<ListActionRunsInput, "projectId" | "actionIds" | "objectTypeIds">
  ): Promise<ListActionRunsResult>
}

export interface ActionsRuntime {
  list(): readonly ActionDefinition[]
  getById(actionId: string): ActionDefinition | null
  listGlobal(): readonly ActionDefinition[]
  listForType(objectType: ObjectType): readonly ActionDefinition[]
  request(input: RequestActionInput): Promise<RequestActionResult>
  requestAndWait(input: RequestActionAndWaitInput): Promise<ActionRunRecord>
  readonly runs: ActionRunsRuntime
}

export function createActionsRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext
): ActionsRuntime {
  const projectId = runtime.projectId
  const runtimeAuthorization = runtime.runtimeAuthorization
  const authorization = resolveRuntimeAuthorizationForProject({
    projectId,
    runtimeAuthorization,
  })
  const canList = (action: ActionDefinition) => {
    if (authorization.type === "denied" || authorization.type === "delegated") return false
    if (authorization.type === "unrestricted") return true
    return (
      isAllowed(authorization.context, { kind: "action.apply", actionId: action.id }) &&
      (action.binding.kind === "global" ||
        isAllowed(authorization.context, {
          kind: "object.view",
          objectTypeId: action.binding.objectType.id,
        }))
    )
  }

  return {
    list: () => runtime.actionRegistry.list().filter(canList),
    getById: (actionId) => {
      const action = runtime.actionRegistry.getById(actionId)
      return action && canList(action) ? action : null
    },
    listGlobal: () => runtime.actionRegistry.listGlobal().filter(canList),
    listForType: (objectType) => runtime.actionRegistry.listForType(objectType).filter(canList),
    request: (input) => requestAction(runtime, execution, input),
    requestAndWait: (input) => requestActionAndWait(runtime, execution, input),
    runs: {
      getById: async (runId) => {
        if (authorization.type === "denied" || authorization.type === "delegated") return null
        const run =
          (await runtime.storage.actionRuns?.getById({
            projectId,
            id: runId,
          })) ?? null
        return run &&
          (authorization.type === "unrestricted" || canViewActionRun(authorization.context, run))
          ? run
          : null
      },
      list: (input = {}) => {
        if (authorization.type === "denied" || authorization.type === "delegated") {
          return Promise.resolve({ runs: [], hasMore: false, total: 0 })
        }
        const storage = runtime.storage.actionRuns
        if (!storage) return Promise.resolve({ runs: [], hasMore: false, total: 0 })
        return storage.list({
          ...input,
          projectId,
          actionIds:
            authorization.type === "principal"
              ? [...authorization.context.grants["apply:action"]]
              : undefined,
          objectTypeIds:
            authorization.type === "principal"
              ? [...authorization.context.grants["view:object"]]
              : undefined,
        })
      },
    },
  }
}
