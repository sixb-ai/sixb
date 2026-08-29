import { canViewActionRun, isAllowed } from "../authorization"
import type { ExecutionContext } from "../execution"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import {
  assertAuthorizedObjectReaderBinding,
  getAuthorizedOntologyView,
} from "../execution/authorized-object-reader"
import type { ObjectType } from "../ontology"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  ActionRunRecord,
  ListActionRunsInput,
  ListActionRunsResult,
} from "../storage/action-runs"
import { assertObjectReadOutputWithinLimit } from "../storage/objects/execution-limits"
import { type ActionDescriptor, snapshotActionDescriptor } from "./descriptor"
import {
  type RequestActionAndWaitInput,
  type RequestActionInput,
  type RequestActionResult,
  requestAction,
  requestActionAndWait,
} from "./request"
import { canDelegationAccessActionRun } from "./run-authorization"
import type { ActionDefinition } from "./types"

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
  const projectId = runtime.projectId
  const runtimeAuthorization = runtime.runtimeAuthorization
  const objectReader = runtime.objectReader
  assertAuthorizedObjectReaderBinding({
    reader: objectReader,
    scope: { execution, authorization: runtimeAuthorization },
  })
  const authorization = resolveRuntimeAuthorizationForProject({
    projectId,
    runtimeAuthorization,
  })
  const canList = (action: ActionDefinition) => {
    if (authorization.type === "denied") return false
    if (authorization.type === "delegated") {
      const binding = action.binding
      return (
        binding.kind === "object" &&
        authorization.actionApply.some(
          (target) =>
            target.actionId === action.id && target.subject.objectTypeId === binding.objectType.id
        ) &&
        getAuthorizedOntologyView(objectReader).getObjectTypeById(binding.objectType.id) !== null
      )
    }
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

  const release = <T>(value: T): T => {
    if (authorization.type === "delegated") {
      assertObjectReadOutputWithinLimit(value, authorization.objectRead.limits)
    }
    return value
  }
  const describeAll = (actions: readonly ActionDefinition[]) =>
    release(actions.filter(canList).map(snapshotActionDescriptor))

  return {
    list: () => describeAll(runtime.actionRegistry.list()),
    getById: (actionId) => {
      const action = runtime.actionRegistry.getById(actionId)
      return release(action && canList(action) ? snapshotActionDescriptor(action) : null)
    },
    listGlobal: () => describeAll(runtime.actionRegistry.listGlobal()),
    listForType: (objectType) =>
      describeAll(
        runtime.actionRegistry
          .listForType(objectType)
          .filter(
            (action) =>
              authorization.type !== "delegated" ||
              (action.binding.kind === "object" && action.binding.objectType.id === objectType.id)
          )
      ),
    request: (input) => requestAction(runtime, execution, input),
    requestAndWait: (input) => requestActionAndWait(runtime, execution, input),
    runs: {
      getById: async (runId) => {
        if (
          authorization.type === "denied" ||
          (authorization.type === "delegated" &&
            (!authorization.delegation || authorization.actionApply.length === 0))
        )
          return null
        const run =
          (await runtime.storage.actionRuns?.getById({
            projectId,
            id: runId,
          })) ?? null
        return run &&
          (authorization.type === "unrestricted" ||
            (authorization.type === "principal" && canViewActionRun(authorization.context, run)) ||
            (authorization.type === "delegated" &&
              (await canDelegationAccessActionRun({
                storage: runtime.storage,
                projectId,
                authority: authorization,
                run,
              }))))
          ? release(run)
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
