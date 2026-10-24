import { isAllowed } from "../authorization"
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
import { type RequestActionInput, requestAction } from "./request"
import {
  canDelegationAccessActionRun,
  canReadActionRunSubject,
  readableSubjects,
  unreadableActionRunTypes,
  viewableActionRuns,
} from "./run-authorization"
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
  /**
   * Run an Action in this process and return its terminal record, without waiting for its effects.
   * A run that fails resolves with status `failed`. The call rejects when the request itself is
   * refused (unknown action, invalid params, missing authority, a run id this process is still
   * running, a stopping runtime), and with `internal.unexpected` when a run that started could not
   * be recorded: requesting it again with the same run id returns its record if it was recorded, and
   * runs it again otherwise.
   */
  request(input: RequestActionInput): Promise<ActionRunRecord>
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
    if (!isAllowed(authorization.context, { kind: "action.apply", actionId: action.id })) {
      return false
    }
    if (action.binding.kind === "global") return true

    // A type viewed through a condition is viewable as the reader decides it: its requests then
    // name objects the reader sees.
    const objectTypeId = action.binding.objectType.id
    return objectReader.viewsThroughCondition(objectTypeId)
      ? getAuthorizedOntologyView(objectReader).getObjectTypeById(objectTypeId) !== null
      : isAllowed(authorization.context, { kind: "object.view", objectTypeId })
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
            (authorization.type === "principal" &&
              (await viewableActionRuns(objectReader, authorization.context, [run])).length > 0) ||
            (authorization.type === "delegated" &&
              (await canDelegationAccessActionRun({
                storage: runtime.storage,
                projectId,
                authority: authorization,
                run,
              })))) &&
          (await canReadActionRunSubject(objectReader, run))
          ? release(run)
          : null
      },
      list: async (input = {}) => {
        if (authorization.type === "denied" || authorization.type === "delegated") {
          return { runs: [], hasMore: false, total: 0 }
        }
        const storage = runtime.storage.actionRuns
        if (!storage) return { runs: [], hasMore: false, total: 0 }
        if (authorization.type === "unrestricted") return storage.list({ ...input, projectId })

        // Storage filters, so its pages and totals only count runs the reader can see. A run on a
        // type viewed through a condition shows only through its subject: a listing that names
        // one the reader reads now includes it, every other listing leaves the type out. HTTP
        // names it by objectTypeId and primaryId.
        const context = authorization.context
        const unreadable = await unreadableActionRunTypes(objectReader)
        const objectTypeIds = [...context.grants["view:object"]].filter(
          (objectTypeId) => !unreadable.has(objectTypeId)
        )

        const subject =
          input.subject ??
          (input.objectTypeId !== undefined && input.primaryId !== undefined
            ? {
                kind: "object" as const,
                objectTypeId: input.objectTypeId,
                primaryId: input.primaryId,
              }
            : undefined)
        if (subject?.kind === "object" && context.viewConditions?.has(subject.objectTypeId)) {
          const readable = await readableSubjects(objectReader, [subject])
          if (readable.size === 0) return { runs: [], hasMore: false, total: 0 }
          objectTypeIds.push(subject.objectTypeId)
        }

        return storage.list({
          ...input,
          projectId,
          actionIds: [...context.grants["apply:action"]],
          objectTypeIds,
        })
      },
    },
  }
}
