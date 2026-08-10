/**
 * Scoped SDK surface returned by `sixb.as(context)`.
 *
 * The scoped types are masks over the full SDK types — derived from the same
 * declarations, never copies — so signatures cannot drift and new surface area
 * stays hidden until its grants are enforceable end to end. The runtime values
 * are the same factories running over an authorization-carrying runtime
 * context; leaf asserts and query planning enforce the grants.
 */

import type {
  ActionDefinition,
  RequestActionAndWaitInput,
  RequestActionInput,
  RequestActionResult,
} from "../actions"
import {
  requestAction as requestRuntimeAction,
  requestActionAndWait as requestRuntimeActionAndWait,
} from "../actions/request"
import type {
  AgentDefinition,
  AgentsRuntime,
  RequestAgentRunInput,
  RequestAgentRunResult,
  ScopedListAgentThreadsInput,
} from "../agents"
import {
  type AuthorizationContext,
  type AuthzRequest,
  assertAuthorized,
  canViewEvent,
  isAllowed,
} from "../authorization"
import type { DatasetDefinition } from "../datasets"
import type { EventsReadInput, StoredDomainEvent } from "../events"
import { createObjectSet, objectService } from "../objects"
import type { ListObjectsParams } from "../objects/service"
import type { ValueType } from "../ontology"
import { assertObjectTypeRegistered } from "../ontology"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import type { PipelineDefinition } from "../pipelines"
import { PipelineError } from "../pipelines"
import {
  type PipelineRunRequestResult,
  type RequestPipelineRunInput,
  requestPipelineRun,
} from "../pipelines/request"
import type { ActionRunRecord } from "../storage/action-runs"
import type { AgentThreadRecord, ListAgentThreadsResult } from "../storage/agents"
import type { SyncDefinition } from "../syncs"
import { SyncValidationError } from "../syncs"
import {
  type RequestSyncRunInput,
  requestSyncRun,
  type SyncRunRequestResult,
} from "../syncs/request"
import type {
  RequestWorkflowRunInput,
  WorkflowDefinition,
  WorkflowRunRequestResult,
  WorkflowsRuntime,
} from "../workflows"
import type {
  ObjectByIdHandle,
  ObjectSet,
  OntologySource,
  RegisteredObjectType,
  RegisteredValueTypes,
  SixbInstance,
  SixbRuntimeContext,
} from "./types"

// Scoped members are indexed accesses of the full SDK types rather than
// `Pick`s: signatures stay single-sourced (no drift), while indexed access
// stays lazy — mapped types would eagerly materialize every method's deep
// query/telemetry conditionals and blow the instantiation depth limit.
export interface ScopedObjectByIdHandle<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
> {
  get: ObjectByIdHandle<TObjectType, TValueTypes>["get"]
  requestAction: ObjectByIdHandle<TObjectType, TValueTypes>["requestAction"]
  requestActionAndWait: ObjectByIdHandle<TObjectType, TValueTypes>["requestActionAndWait"]
  /** Requires `edit:object` on this type and `view:object` on the link target. */
  link: ObjectByIdHandle<TObjectType, TValueTypes>["link"]
  /** Requires `edit:object` on this type and `view:object` on the link target. */
  unlink: ObjectByIdHandle<TObjectType, TValueTypes>["unlink"]
  /** Requires `edit:object`. */
  delete: ObjectByIdHandle<TObjectType, TValueTypes>["delete"]
  /** Requires `edit:object`. */
  restore: ObjectByIdHandle<TObjectType, TValueTypes>["restore"]
  /** `append()` requires `append:telemetry`; `history()` requires `view:object`. */
  telemetry: ObjectByIdHandle<TObjectType, TValueTypes>["telemetry"]
  // `listLinks` stays off this surface: its rows name target types that no read grant covers.
}

export interface ScopedObjectSet<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
  TRegisteredObjectTypes extends ObjectTypeWithPropertyTokens = TObjectType,
> {
  get: ObjectSet<TObjectType, TValueTypes, TRegisteredObjectTypes>["get"]
  list: ObjectSet<TObjectType, TValueTypes, TRegisteredObjectTypes>["list"]
  query: ObjectSet<TObjectType, TValueTypes, TRegisteredObjectTypes>["query"]
  requestAction: ObjectSet<TObjectType, TValueTypes, TRegisteredObjectTypes>["requestAction"]
  requestActionAndWait: ObjectSet<
    TObjectType,
    TValueTypes,
    TRegisteredObjectTypes
  >["requestActionAndWait"]
  /** Requires `view:object` and `edit:object`. */
  upsert: ObjectSet<TObjectType, TValueTypes, TRegisteredObjectTypes>["upsert"]
  /** Requires `edit:object` on this type and `view:object` on the link target. */
  upsertLink: ObjectSet<TObjectType, TValueTypes, TRegisteredObjectTypes>["upsertLink"]
  /** Requires `edit:object` on this type and `view:object` on the link target. */
  removeLink: ObjectSet<TObjectType, TValueTypes, TRegisteredObjectTypes>["removeLink"]
  /** Requires `append:telemetry` — and notably not `view:object`. */
  appendTelemetryBatch: ObjectSet<
    TObjectType,
    TValueTypes,
    TRegisteredObjectTypes
  >["appendTelemetryBatch"]

  /** Bind read, write, and action operations to a specific object id. */
  byId(id: string): ScopedObjectByIdHandle<TObjectType, TValueTypes>
}

export interface ScopedObjectsRuntime<TOntologySources extends readonly OntologySource[]> {
  <TObjectType extends RegisteredObjectType<TOntologySources>>(
    objectType: TObjectType
  ): ScopedObjectSet<
    TObjectType,
    RegisteredValueTypes<TOntologySources>,
    RegisteredObjectType<TOntologySources>
  >
  list: SixbInstance<TOntologySources>["objects"]["list"]
  get: SixbInstance<TOntologySources>["objects"]["get"]
  getPrimaryPropertyId: SixbInstance<TOntologySources>["objects"]["getPrimaryPropertyId"]
  upsert: SixbInstance<TOntologySources>["objects"]["upsert"]
  upsertBatch: SixbInstance<TOntologySources>["objects"]["upsertBatch"]
  upsertLink: SixbInstance<TOntologySources>["objects"]["upsertLink"]
  upsertLinkBatch: SixbInstance<TOntologySources>["objects"]["upsertLinkBatch"]
  removeLink: SixbInstance<TOntologySources>["objects"]["removeLink"]
  appendTelemetry: SixbInstance<TOntologySources>["objects"]["appendTelemetry"]
}

export interface ScopedActionsRuntime {
  list(): readonly ActionDefinition[]
  getById(actionId: string): ActionDefinition | null
  request(input: RequestActionInput): Promise<RequestActionResult>
  requestAndWait(input: RequestActionAndWaitInput): Promise<ActionRunRecord>
}

export interface ScopedDefinitionsRuntime<TDefinition> {
  list(): readonly TDefinition[]
  getById(id: string): TDefinition | null
}

export interface ScopedWorkflowsRuntime extends ScopedDefinitionsRuntime<WorkflowDefinition> {
  requestById(input: RequestWorkflowRunInput): Promise<WorkflowRunRequestResult>
}

export interface ScopedSyncsRuntime extends ScopedDefinitionsRuntime<SyncDefinition> {
  request(input: RequestSyncRunInput): Promise<SyncRunRequestResult>
}

export interface ScopedPipelinesRuntime extends ScopedDefinitionsRuntime<PipelineDefinition> {
  request(input: RequestPipelineRunInput): Promise<PipelineRunRequestResult>
}

export interface ScopedAgentsRuntime extends ScopedDefinitionsRuntime<AgentDefinition> {
  request(input: RequestAgentRunInput): Promise<RequestAgentRunResult>
  listThreads(input?: ScopedListAgentThreadsInput): Promise<ListAgentThreadsResult>
  getThread(threadId: string): Promise<AgentThreadRecord | null>
}

export interface ScopedEventsRuntime {
  read(input?: EventsReadInput): Promise<readonly StoredDomainEvent[]>
}

/**
 * Principal-scoped runtime surface.
 *
 * Exposes only operations whose grants are enforceable end to end (`can.view`, `can.edit`,
 * `can.append`, `can.apply`, `can.run`, `can.observe`). Infra handles, lifecycle, auth
 * administration, and `listLinks` stay on the privileged runtime.
 */
export interface ScopedSixb<TOntologySources extends readonly OntologySource[]> {
  /** The authorization context this SDK instance enforces. */
  readonly authorization: AuthorizationContext

  readonly objects: ScopedObjectsRuntime<TOntologySources>
  readonly actions: ScopedActionsRuntime
  readonly datasets: ScopedDefinitionsRuntime<DatasetDefinition>
  readonly workflows: ScopedWorkflowsRuntime
  readonly syncs: ScopedSyncsRuntime
  readonly pipelines: ScopedPipelinesRuntime
  readonly agents: ScopedAgentsRuntime
  readonly events: ScopedEventsRuntime
}

export function createScopedSixb<TOntologySources extends readonly OntologySource[]>(
  runtime: SixbRuntimeContext & { readonly authorization: AuthorizationContext },
  deps: {
    readonly datasets: {
      readonly list: () => readonly DatasetDefinition[]
      readonly getById: (datasetId: string) => DatasetDefinition | null
    }
    readonly syncs: {
      readonly list: () => readonly SyncDefinition[]
      readonly getById: (syncId: string) => SyncDefinition | null
    }
    readonly pipelines: {
      readonly list: () => readonly PipelineDefinition[]
      readonly getById: (pipelineId: string) => PipelineDefinition | null
    }
    readonly workflows: WorkflowsRuntime
    readonly agents: AgentsRuntime
  }
): ScopedSixb<TOntologySources> {
  const canListAction = (action: ActionDefinition) =>
    isAllowed(runtime.authorization, { kind: "action.apply", actionId: action.id }) &&
    (action.binding.kind === "global" ||
      isAllowed(runtime.authorization, {
        kind: "object.view",
        objectTypeId: action.binding.objectType.id,
      }))

  // A scoped catalog narrows a definition source to what the principal may see.
  // The run/view grant doubles as catalog visibility: a definition the principal
  // cannot run/view is not worth surfacing, and hiding it also hides the
  // (possibly ungranted) resources its shape references.
  const scopedCatalog = <T extends { readonly id: string }>(
    source: { list(): readonly T[]; getById(id: string): T | null },
    toRequest: (id: string) => AuthzRequest
  ) => {
    const allowed = (id: string) => isAllowed(runtime.authorization, toRequest(id))
    return {
      list: () => source.list().filter((item) => allowed(item.id)),
      getById: (id: string) => {
        const item = source.getById(id)
        return item && allowed(id) ? item : null
      },
    }
  }

  const datasets = scopedCatalog(deps.datasets, (datasetId) => ({
    kind: "dataset.view",
    datasetId,
  }))
  const syncs = scopedCatalog(deps.syncs, (syncId) => ({ kind: "sync.run", syncId }))
  const pipelines = scopedCatalog(deps.pipelines, (pipelineId) => ({
    kind: "pipeline.run",
    pipelineId,
  }))
  const workflows = scopedCatalog(deps.workflows, (workflowId) => ({
    kind: "workflow.run",
    workflowId,
  }))
  const agents = scopedCatalog(deps.agents, (agentId) => ({ kind: "agent.run", agentId }))

  const objects = Object.assign(
    <TObjectType extends RegisteredObjectType<TOntologySources>>(objectType: TObjectType) => {
      assertObjectTypeRegistered(runtime.ontology.getObjectTypesById(), objectType)

      return createObjectSet<
        TObjectType,
        RegisteredObjectType<TOntologySources>,
        RegisteredValueTypes<TOntologySources>
      >({ ...runtime, objectType }) as ScopedObjectSet<
        TObjectType,
        RegisteredValueTypes<TOntologySources>,
        RegisteredObjectType<TOntologySources>
      >
    },
    {
      list: (params: ListObjectsParams) => objectService.listObjects(runtime, params),
      get: async (objectTypeId: string, primaryId: string) => {
        assertAuthorized(runtime, { kind: "object.view", objectTypeId })
        return runtime.storage.objects.getByPrimaryId({
          projectId: runtime.projectId,
          objectTypeId,
          primaryId,
        })
      },
      getPrimaryPropertyId: (objectTypeId: string) => {
        assertAuthorized(runtime, { kind: "object.view", objectTypeId })
        return runtime.ontology.getPrimaryPropertyId(objectTypeId)
      },
      upsert: (objectTypeId: string, properties: Record<string, unknown>) =>
        objectService.upsertObject(runtime, objectTypeId, properties),
      upsertBatch: (
        objectTypeId: string,
        items: readonly { properties: Record<string, unknown> }[]
      ) => objectService.upsertObjectBatch(runtime, objectTypeId, items),
      upsertLink: (
        objectTypeId: string,
        sourceId: string,
        linkId: string,
        target: { targetTypeId: string; targetId: string; properties?: Record<string, unknown> }
      ) => objectService.upsertLink(runtime, objectTypeId, sourceId, linkId, target),
      upsertLinkBatch: (
        items: readonly {
          objectTypeId: string
          sourceId: string
          linkId: string
          target: { targetTypeId: string; targetId: string; properties?: Record<string, unknown> }
        }[]
      ) => objectService.upsertLinkBatch(runtime, items),
      removeLink: (
        objectTypeId: string,
        sourceId: string,
        linkId: string,
        target: { targetTypeId: string; targetId: string }
      ) => objectService.removeLink(runtime, objectTypeId, sourceId, linkId, target),
      appendTelemetry: (
        objectTypeId: string,
        items: readonly { id: string; properties: Record<string, unknown>; at?: Date }[]
      ) => objectService.appendTelemetry(runtime, objectTypeId, items),
    }
  )

  const scoped = {
    authorization: runtime.authorization,
    objects,
    datasets,
    actions: {
      list: () => runtime.actionRegistry.list().filter((action) => canListAction(action)),
      getById: (actionId: string) => {
        const action = runtime.actionRegistry.getById(actionId)
        return action && canListAction(action) ? action : null
      },
      request: (input: RequestActionInput) => requestRuntimeAction(runtime, input),
      requestAndWait: (input: RequestActionAndWaitInput) =>
        requestRuntimeActionAndWait(runtime, input),
    },
    workflows: {
      ...workflows,
      requestById: (input: RequestWorkflowRunInput) => deps.workflows.requestByIdAs(runtime, input),
    },
    syncs: {
      ...syncs,
      request: async (input: RequestSyncRunInput) => {
        const sync = deps.syncs.getById(input.syncId)
        if (!sync) throw new SyncValidationError(`[Sixb] Unknown sync '${input.syncId}'`)
        return requestSyncRun(runtime, sync, input)
      },
    },
    pipelines: {
      ...pipelines,
      request: async (input: RequestPipelineRunInput) => {
        const pipeline = deps.pipelines.getById(input.pipelineId)
        if (!pipeline) throw new PipelineError(`[Sixb] Unknown pipeline '${input.pipelineId}'`)
        return requestPipelineRun(runtime, pipeline, input)
      },
    },
    agents: {
      ...agents,
      request: (input: RequestAgentRunInput) => deps.agents.requestAs(runtime, input),
      listThreads: (input?: ScopedListAgentThreadsInput) =>
        deps.agents.listThreadsAs(runtime, input),
      getThread: (threadId: string) => deps.agents.getThreadAs(runtime, threadId),
    },
    events: {
      read: async (input?: EventsReadInput) => {
        const events = await runtime.events.read(input)
        return events.filter((event) => canViewEvent(runtime.authorization, event))
      },
    },
  }

  // Boundary cast: checking the literal against ScopedSixb<TOntologySources>
  // triggers excessively deep ObjectSet instantiation (same constraint noted
  // on SixbInstance). The mask only hides members of the full SDK values.
  return scoped as unknown as ScopedSixb<TOntologySources>
}
