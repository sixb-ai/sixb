import { canViewActionRun, isRuntimeAllowed } from "../authorization"
import { accessPlanCanApplyActionToObjectType } from "../authorization/access-plan"
import type { ExecutionContext } from "../execution"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import type { ObjectType } from "../ontology"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  ActionRunRecord,
  ListActionRunsInput,
  ListActionRunsResult,
} from "../storage/action-runs"
import { type ActionDescriptor, snapshotActionDescriptor } from "./descriptor"
import {
  type RequestActionAndWaitInput,
  type RequestActionInput,
  type RequestActionResult,
  requestAction,
  requestActionAndWait,
} from "./request"
import type { ActionDefinition } from "./types"
import { isExactObjectActionTarget } from "./validation"

export interface ActionRunsRuntime {
  getById(runId: string): Promise<ActionRunRecord | null>
  list(
    input?: Omit<ListActionRunsInput, "projectId" | "actionIds" | "objectTypeIds">
  ): Promise<ListActionRunsResult>
}

export interface ActionsRuntime {
  list(): readonly ActionDescriptor[]
  getById(actionId: string): ActionDescriptor | null
  listGlobal(): readonly ActionDescriptor[]
  listForType(objectType: ObjectType): readonly ActionDescriptor[]
  request(input: RequestActionInput): Promise<RequestActionResult>
  requestAndWait(input: RequestActionAndWaitInput): Promise<ActionRunRecord>
  readonly runs: ActionRunsRuntime
}

export function createActionsRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext
): ActionsRuntime {
  const authority = resolveRuntimeAuthorizationForProject(runtime)
  const descriptors = new WeakMap<ActionDefinition, ActionDescriptor>()
  const describe = (action: ActionDefinition): ActionDescriptor => {
    const existing = descriptors.get(action)
    if (existing) return existing
    const descriptor = snapshotActionDescriptor(action)
    descriptors.set(action, descriptor)
    return descriptor
  }
  const describeAll = (actions: readonly ActionDefinition[]): readonly ActionDescriptor[] =>
    Object.freeze(actions.map(describe))
  const canListForConcreteType = (action: ActionDefinition, objectTypeId: string): boolean => {
    if (action.binding.kind === "global") return false
    if (!isRuntimeAllowed(runtime, { kind: "action.apply", actionId: action.id })) return false
    if (!isRuntimeAllowed(runtime, { kind: "object.view", objectTypeId })) return false
    return (
      authority.type !== "delegated" ||
      (isExactObjectActionTarget(action, objectTypeId) &&
        accessPlanCanApplyActionToObjectType(authority.access, action.id, objectTypeId))
    )
  }
  const canList = (action: ActionDefinition): boolean => {
    if (!isRuntimeAllowed(runtime, { kind: "action.apply", actionId: action.id })) return false
    if (action.binding.kind === "global") return authority.type !== "delegated"

    // V1 delegated authority intentionally does not inherit object Actions. Until descriptors can
    // express authority-aware applicability, exposing a parent Action through an exact subtype
    // grant would advertise a target that its binding cannot safely represent.
    if (authority.type === "delegated") {
      return canListForConcreteType(action, action.binding.objectType.id)
    }

    // Principal and unrestricted runtimes retain normal ontology inheritance.
    const applicableTypeIds = [
      action.binding.objectType.id,
      ...runtime.ontology.listSubTypes(action.binding.objectType.id),
    ]
    return applicableTypeIds.some((objectTypeId) => canListForConcreteType(action, objectTypeId))
  }

  return {
    list: () =>
      describeAll(authority.type === "denied" ? [] : runtime.actionRegistry.list().filter(canList)),
    getById: (actionId) => {
      if (authority.type === "denied") return null
      const action = runtime.actionRegistry.getById(actionId)
      return action && canList(action) ? describe(action) : null
    },
    listGlobal: () =>
      describeAll(
        authority.type === "denied" || authority.type === "delegated"
          ? []
          : runtime.actionRegistry.listGlobal().filter(canList)
      ),
    listForType: (objectType) =>
      describeAll(
        authority.type === "denied"
          ? []
          : runtime.actionRegistry
              .listForType(objectType)
              .filter((action) => canListForConcreteType(action, objectType.id))
      ),
    request: (input) => requestAction(runtime, execution, input),
    requestAndWait: (input) => requestActionAndWait(runtime, execution, input),
    runs: {
      getById: async (runId) => {
        switch (authority.type) {
          case "denied":
          case "delegated":
            return null
          case "principal":
          case "unrestricted":
            break
        }
        const run =
          (await runtime.storage.actionRuns?.getById({
            projectId: runtime.projectId,
            id: runId,
          })) ?? null
        if (!run) return null
        return authority.type === "unrestricted" || canViewActionRun(authority.context, run)
          ? run
          : null
      },
      list: (input = {}) => {
        switch (authority.type) {
          case "denied":
          case "delegated":
            return Promise.resolve({ runs: [], hasMore: false, total: 0 })
          case "principal":
          case "unrestricted":
            break
        }
        const storage = runtime.storage.actionRuns
        if (!storage) return Promise.resolve({ runs: [], hasMore: false, total: 0 })
        return storage.list({
          ...input,
          actionIds:
            authority.type === "principal"
              ? [...authority.context.grants["apply:action"]]
              : undefined,
          objectTypeIds:
            authority.type === "principal"
              ? [...authority.context.grants["view:object"]]
              : undefined,
          projectId: runtime.projectId,
        })
      },
    },
  }
}
