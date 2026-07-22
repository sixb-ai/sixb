/**
 * Scoped SDK surface returned by `sixb.as(context)`.
 *
 * The scoped types are masks over the full SDK types — derived from the same
 * declarations, never copies — so signatures cannot drift and new surface area
 * stays hidden until its grants are enforceable end to end. The runtime values
 * are the same factories running over an authorization-carrying runtime
 * context; leaf asserts and query planning enforce the grants.
 */

import type { ActionDefinition, RequestActionInput, RequestActionResult } from "../actions"
import { requestAction as requestRuntimeAction } from "../actions/request"
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
import type { ObjectRow } from "../storage"
import type { AgentThreadRecord, ListAgentThreadsResult } from "../storage/agents"
import type { SyncDefinition } from "../syncs"
import type {
  RequestWorkflowRunInput,
  WorkflowDefinition,
  WorkflowRunRequestResult,
  WorkflowsRuntime,
} from "../workflows"
import type {
  ListResult,
  ObjectByIdHandle,
  ObjectSet,
  OntologySource,
  RegisteredObjectType,
  RegisteredValueTypes,
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

  /** Bind read and action operations to a specific object id. */
  byId(id: string): ScopedObjectByIdHandle<TObjectType, TValueTypes>
}

/**
 * Principal-scoped runtime surface.
 *
 * Exposes only operations whose grants are enforceable end to end
 * (`can.view`, `can.apply`, `can.run`). Everything else — writes, links, telemetry,
 * infra handles, lifecycle, auth — stays on the privileged runtime.
 */
export interface ScopedSixb<TOntologySources extends readonly OntologySource[]> {
  /** The authorization context this SDK instance enforces. */
  readonly authorization: AuthorizationContext

  /** Type-safe ObjectSet narrowed to grant-enforceable operations. */
  objects<TObjectType extends RegisteredObjectType<TOntologySources>>(
    objectType: TObjectType
  ): ScopedObjectSet<
    TObjectType,
    RegisteredValueTypes<TOntologySources>,
    RegisteredObjectType<TOntologySources>
  >

  /** Cross-type listing narrowed to the principal's viewable object types. */
  list(params: ListObjectsParams): Promise<ListResult<ObjectRow>>

  /** Get an object by type id and primary id (server / dynamic contexts). */
  getObject(objectTypeId: string, primaryId: string): Promise<ObjectRow | null>

  /** Dataset definitions the principal may view. */
  listDatasets(): readonly DatasetDefinition[]

  /** Look up a viewable dataset definition; null hides ungranted datasets. */
  getDatasetById(datasetId: string): DatasetDefinition | null

  /** Action definitions the principal may apply. */
  listActions(): readonly ActionDefinition[]

  /** Look up an applicable action definition; null hides ungranted actions. */
  getActionById(actionId: string): ActionDefinition | null

  /** Request an action by id (server / dynamic contexts). Requires `can.apply`. */
  requestAction(input: RequestActionInput): Promise<RequestActionResult>

  /** Start a workflow run. Requires `can.run`. */
  runWorkflow(input: RequestWorkflowRunInput): Promise<WorkflowRunRequestResult>

  /** Workflow definitions the principal may run. */
  listWorkflows(): readonly WorkflowDefinition[]

  /** Look up a runnable workflow definition; null hides workflows the principal cannot run. */
  getWorkflowById(workflowId: string): WorkflowDefinition | null

  /** Sync definitions the principal may run. */
  listSyncs(): readonly SyncDefinition[]

  /** Look up a runnable sync definition; null hides syncs the principal cannot run. */
  getSyncById(syncId: string): SyncDefinition | null

  /** Pipeline definitions the principal may run. */
  listPipelines(): readonly PipelineDefinition[]

  /** Look up a runnable pipeline definition; null hides pipelines the principal cannot run. */
  getPipelineById(pipelineId: string): PipelineDefinition | null

  /** Agent definitions the principal may run. */
  listAgents(): readonly AgentDefinition[]

  /** Look up a runnable agent definition; null hides agents the principal cannot run. */
  getAgentById(agentId: string): AgentDefinition | null

  /** Request an agent turn. Requires `can.run`. */
  requestAgentRun(input: RequestAgentRunInput): Promise<RequestAgentRunResult>

  /** List agent threads the principal owns and may run (owner + `run:agent` filtered). */
  listThreads(input?: ScopedListAgentThreadsInput): Promise<ListAgentThreadsResult>

  /** Read one agent thread the principal owns and may run; null hides inaccessible threads. */
  getThread(threadId: string): Promise<AgentThreadRecord | null>

  /** Read the domain events the principal is allowed to see (derived from grants). */
  readEvents(input?: EventsReadInput): Promise<readonly StoredDomainEvent[]>
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
  const canRunWorkflow = (workflow: WorkflowDefinition) =>
    isAllowed(runtime.authorization, { kind: "workflow.run", workflowId: workflow.id }) &&
    workflow.nodes.every(
      (node) =>
        node.type !== "agent" ||
        isAllowed(runtime.authorization, {
          kind: "agent.run",
          agentId: node.agentStep.agent.id,
        })
    )
  const workflows = {
    list: () => deps.workflows.list().filter(canRunWorkflow),
    getById: (workflowId: string) => {
      const workflow = deps.workflows.getById(workflowId)
      return workflow && canRunWorkflow(workflow) ? workflow : null
    },
  }
  const agents = scopedCatalog(deps.agents, (agentId) => ({ kind: "agent.run", agentId }))

  const scoped = {
    authorization: runtime.authorization,

    objects<TObjectType extends RegisteredObjectType<TOntologySources>>(objectType: TObjectType) {
      assertObjectTypeRegistered(runtime.ontology.getObjectTypesById(), objectType)

      return createObjectSet<
        TObjectType,
        RegisteredObjectType<TOntologySources>,
        RegisteredValueTypes<TOntologySources>
      >({ ...runtime, objectType })
    },

    list: (params: ListObjectsParams) => objectService.listObjects(runtime, params),

    getObject: async (objectTypeId: string, primaryId: string) => {
      assertAuthorized(runtime, { kind: "object.view", objectTypeId })
      return runtime.storage.objects.getByPrimaryId({
        projectId: runtime.projectId,
        objectTypeId,
        primaryId,
      })
    },

    listDatasets: datasets.list,
    getDatasetById: datasets.getById,

    listActions: () => runtime.actionRegistry.list().filter((action) => canListAction(action)),

    getActionById: (actionId: string) => {
      const action = runtime.actionRegistry.getById(actionId)
      return action && canListAction(action) ? action : null
    },

    requestAction: (input: RequestActionInput) => requestRuntimeAction(runtime, input),

    runWorkflow: (input: RequestWorkflowRunInput) => deps.workflows.requestByIdAs(runtime, input),

    listWorkflows: workflows.list,
    getWorkflowById: workflows.getById,

    listSyncs: syncs.list,
    getSyncById: syncs.getById,

    listPipelines: pipelines.list,
    getPipelineById: pipelines.getById,

    listAgents: agents.list,
    getAgentById: agents.getById,
    requestAgentRun: (input: RequestAgentRunInput) => deps.agents.requestAs(runtime, input),
    listThreads: (input?: ScopedListAgentThreadsInput) => deps.agents.listThreadsAs(runtime, input),
    getThread: (threadId: string) => deps.agents.getThreadAs(runtime, threadId),

    // No standalone events grant: the stream is filtered to events whose
    // subject the principal may view/apply/run. `limit` applies before this
    // filter, so a page may return fewer events than requested — acceptable for
    // a best-effort recent log (storage-level filtering is the planned fix).
    readEvents: async (input?: EventsReadInput) => {
      const events = await runtime.events.read(input)
      return events.filter((event) => canViewEvent(runtime.authorization, event))
    },
  }

  // Boundary cast: checking the literal against ScopedSixb<TOntologySources>
  // triggers excessively deep ObjectSet instantiation (same constraint noted
  // on SixbInstance). The mask only hides members of the full SDK values.
  return scoped as unknown as ScopedSixb<TOntologySources>
}
