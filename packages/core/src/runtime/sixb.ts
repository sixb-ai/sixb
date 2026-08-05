/**
 * Sixb is the main runtime entry point.
 *
 * It provides a typed API (`objects(MyType)`) returning ObjectSet with full compile-time inference.
 * For direct runtime access (broker records, events, storage, queued work), use
 * `sixb.broker`, `sixb.events`, `sixb.storage`, and `sixb.queues`.
 */

import { resolve } from "node:path"
import { ActionRegistry, ActionsRuntime } from "../actions"
import type {
  RequestActionAndWaitInput,
  RequestActionInput,
  RequestActionResult,
} from "../actions/request"
import {
  requestAction as requestRuntimeAction,
  requestActionAndWait as requestRuntimeActionAndWait,
} from "../actions/request"
import type { ActionDefinition } from "../actions/types"
import type { AgentDefinition, RequestAgentRunInput, RequestAgentRunResult } from "../agents"
import { AgentsRuntime, validateAgentGroupReferences, validateAgentToolsAtStartup } from "../agents"
import {
  AuthRuntime,
  AuthRuntimeError,
  isMagicLinkAuthStrategy,
  isOidcAuthStrategy,
  type SixbAuthConfig,
} from "../auth"
import type { AuthorizationContext } from "../authorization"
import type { BlobStorage } from "../blob-storage"
import type { Broker } from "../broker"
import { ConnectorRuntime } from "../connectors/runtime"
import type { ConnectorAdapter, ConnectorClient, ConnectorDefinition } from "../connectors/types"
import type { DatasetDefinition } from "../datasets/types"
import { assertDatasetDefinition } from "../datasets/validation"
import { attachSixbErrorReporter, shareSixbErrorReporter } from "../error-reporting/capability"
import { reportEventDeliveryFailure } from "../error-reporting/reports"
import type { SixbErrorHandler } from "../error-reporting/types"
import { type DomainEventLog, EventsRuntime, OntologyOutboxDispatcher } from "../events"
import type { LakeStorage } from "../lake-storage"
import { type LoggerProvider, LogsRuntime, type ObservabilityOptions } from "../logging"
import {
  OntologyMaintenance,
  type OntologyMaintenanceHandle,
  type OntologyMaintenanceOptions,
  type OntologyOperationalStatus,
  type SixbReadiness,
} from "../maintenance"
import { createOntologyMaterializer } from "../materializer"
import { createObjectSet, objectService } from "../objects"
import {
  assertObjectTypeRegistered,
  type ObjectType,
  OntologyRegistry,
  type ValueType,
} from "../ontology"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import { PipelineError } from "../pipelines"
import {
  type PipelineRunRequestResult,
  type RequestPipelineRunInput,
  requestPipelineRun,
} from "../pipelines/request"
import type { PipelineDefinition } from "../pipelines/types"
import { registerProjectionRegistry } from "../projections/internal"
import { ProjectionRegistry } from "../projections/registry"
import type {
  LinkProjectionDefinition,
  ObjectProjectionDefinition,
  ProjectionDefinition,
  TelemetryProjectionDefinition,
} from "../projections/types"
import type { Queues } from "../queues"
import type { RuleDefinition } from "../rules"
import { validateRulesAtStartup } from "../rules"
import type { SandboxFactory } from "../sandboxes"
import { SchedulerRuntime } from "../scheduler"
import type { ScheduleDefinition } from "../schedules"
import { validateSchedulesAtStartup } from "../schedules"
import type {
  GroupDefinition,
  MembershipPolicyDefinition,
  RoleDefinition,
  SecurityRegistry,
} from "../security"
import { createRuntimeSecurityRegistry } from "../security/runtime"
import type { ActionRunRecord, ObjectRow, Storage } from "../storage"
import type { SyncDefinition } from "../syncs"
import { SyncValidationError } from "../syncs"
import {
  type RequestSyncRunInput,
  requestSyncRun,
  type SyncRunRequestResult,
} from "../syncs/request"
import type { RegisteredWebhook } from "../webhooks"
import { registerWebhooks, WebhookValidationError, webhookRoute } from "../webhooks"
import type {
  RequestWorkflowRunInput,
  WorkflowDefinition,
  WorkflowRunRequestResult,
} from "../workflows"
import { validateWorkflowsAtStartup, WorkflowsRuntime } from "../workflows"
import { RuntimeError } from "./errors"
import {
  createOntologyMutationRuntime,
  registerOntologyMutationRuntime,
} from "./ontology-mutations"
import { createScopedSixb, type ScopedSixb } from "./scoped"
import { StorageReadiness } from "./storage-readiness"
import type {
  BatchItemResult,
  ListResult,
  ObjectSet,
  OntologySource,
  RegisteredObjectType,
  RegisteredValueTypes,
  SixbInstance,
  SixbRuntimeContext,
} from "./types"

export interface SixbOptions<TOntologySources extends readonly OntologySource[]> {
  id?: string
  ontology: TOntologySources
  broker: Broker
  storage: Storage
  lakeStorage: LakeStorage
  blobStorage: BlobStorage
  queues: Queues
  sandboxes?: SandboxFactory
  /** Optional process-level output provider. Omit for broker-only logging. */
  logger?: LoggerProvider
  /** Broker capture controls, independent from the output provider. */
  observability?: ObservabilityOptions
  /** Observes runtime failures without changing their outcome. */
  onError?: SixbErrorHandler
  /** Recovery and retention settings. The runtime constructor never starts maintenance timers. */
  ontologyMaintenance?: OntologyMaintenanceOptions
  projectRoot?: string
  actions?: readonly ActionDefinition[]
  datasets?: readonly DatasetDefinition[]
  /** Connector definitions registered with this runtime. */
  connectors?: readonly ConnectorDefinition[]
  schedules?: readonly ScheduleDefinition[]
  syncs?: readonly SyncDefinition[]
  pipelines?: readonly PipelineDefinition[]
  projections?: readonly ProjectionDefinition[]
  rules?: readonly RuleDefinition[]
  workflows?: readonly WorkflowDefinition[]
  agents?: readonly AgentDefinition[]
  groups?: readonly GroupDefinition[]
  roles?: readonly RoleDefinition[]
  membershipPolicies?: readonly MembershipPolicyDefinition[]
  auth?: SixbAuthConfig
}

export class Sixb<TOntologySources extends readonly OntologySource[]>
  implements SixbInstance<TOntologySources>
{
  readonly projectId: string
  private readonly ontologySources: TOntologySources
  private readonly datasetsById = new Map<string, DatasetDefinition>()
  private readonly schedulesById = new Map<string, ScheduleDefinition>()
  private readonly syncsById = new Map<string, SyncDefinition>()
  private readonly pipelinesById = new Map<string, PipelineDefinition>()
  private readonly rulesById = new Map<string, RuleDefinition>()
  private readonly connectorRuntime: ConnectorRuntime
  private readonly webhooksByRoute = new Map<string, RegisteredWebhook>()
  private readonly webhooks: readonly RegisteredWebhook[]
  private readonly runtimeContext: SixbRuntimeContext
  private readonly committedFacts: OntologyOutboxDispatcher
  private readonly eventsRuntime: EventsRuntime
  private readonly ontologyMaintenance: OntologyMaintenance
  private readonly storageReadiness: StorageReadiness
  private readonly projectionRegistry: ProjectionRegistry
  readonly ontology: OntologyRegistry
  readonly actionRegistry: ActionRegistry
  readonly actions: ActionsRuntime
  readonly workflows: WorkflowsRuntime
  readonly agents: AgentsRuntime
  readonly broker: Broker
  readonly events: DomainEventLog
  readonly logs: LogsRuntime
  readonly storage: Storage
  readonly lakeStorage: LakeStorage
  readonly blobStorage: BlobStorage
  readonly queues: Queues
  readonly sandboxes?: SandboxFactory
  readonly projectRoot: string
  readonly rules: readonly RuleDefinition[]
  readonly security: SecurityRegistry
  readonly auth: AuthRuntime
  private schedulerRuntime: SchedulerRuntime | null = null

  constructor(options: SixbOptions<TOntologySources>) {
    const errorReporter = attachSixbErrorReporter(this, options.onError)
    this.projectId = options.id ?? "default"
    this.ontologySources = options.ontology
    this.broker = options.broker
    this.eventsRuntime = new EventsRuntime({
      projectId: this.projectId,
      broker: this.broker,
      errorReporter,
    })
    this.events = this.eventsRuntime
    this.logs = new LogsRuntime({
      projectId: this.projectId,
      broker: this.broker,
      logger: options.logger,
      observability: options.observability?.logs,
    })
    this.storage = options.storage
    this.storageReadiness = new StorageReadiness(this.storage)
    this.lakeStorage = options.lakeStorage
    this.blobStorage = options.blobStorage
    this.queues = options.queues
    this.sandboxes = options.sandboxes
    this.projectRoot = resolve(options.projectRoot ?? process.cwd())
    this.rules = options.rules ?? []
    // Ontology and actions resolve first so every later registry (security,
    // rules, workflows, projections) can validate its references against them.
    this.ontology = new OntologyRegistry({ sources: this.ontologySources })
    this.actionRegistry = new ActionRegistry(options.actions ?? [], this.ontology)
    const registeredActionIds = new Set(this.actionRegistry.list().map((action) => action.id))
    const agents = options.agents ?? []
    validateAgentToolsAtStartup(agents)
    this.security = createRuntimeSecurityRegistry({
      groups: options.groups ?? [],
      roles: options.roles ?? [],
      membershipPolicies: options.membershipPolicies ?? [],
      objectTypeIds: new Set(this.ontology.getObjectTypesById().keys()),
      datasetIds: new Set((options.datasets ?? []).map((dataset) => dataset.id)),
      actionIds: registeredActionIds,
      workflowIds: new Set((options.workflows ?? []).map((workflow) => workflow.id)),
      syncIds: new Set((options.syncs ?? []).map((sync) => sync.id)),
      pipelineIds: new Set((options.pipelines ?? []).map((pipeline) => pipeline.id)),
      agentIds: new Set(agents.map((agent) => agent.id)),
      getSubTypes: (objectTypeId) => this.ontology.listSubTypes(objectTypeId),
    })
    this.auth = new AuthRuntime({
      projectId: this.projectId,
      storage: this.storage,
      security: this.security,
      config: options.auth,
    })
    validateAuthStrategySecurityReferences(this.auth.getStrategy(), this.security)
    this.connectorRuntime = new ConnectorRuntime(this.projectId, options.connectors ?? [])
    const connectors = this.connectorRuntime.list()
    assertWebhookDeliveryStorage(connectors, this.storage)
    this.webhooks = registerWebhooks(connectors).webhooks

    for (const registered of this.webhooks) {
      this.webhooksByRoute.set(registered.route, registered)
    }

    // Register datasets first so sync and pipeline definitions can be validated
    // against the runtime dataset registry during startup.
    for (const dataset of options.datasets ?? []) {
      assertDatasetDefinition(dataset, (message) => new RuntimeError(message))

      if (this.datasetsById.has(dataset.id)) {
        throw new RuntimeError(`Duplicate dataset id: ${dataset.id}`)
      }

      this.datasetsById.set(dataset.id, dataset)
    }

    for (const schedule of options.schedules ?? []) {
      if (this.schedulesById.has(schedule.id)) {
        throw new RuntimeError(`Duplicate schedule id: ${schedule.id}`)
      }
      this.schedulesById.set(schedule.id, schedule)
    }

    for (const sync of options.syncs ?? []) {
      if (this.syncsById.has(sync.id)) {
        throw new RuntimeError(`Duplicate sync id: ${sync.id}`)
      }

      const dataset = this.datasetsById.get(sync.target.dataset.id)
      if (!dataset) {
        throw new RuntimeError(
          `Sync '${sync.id}' targets unknown dataset '${sync.target.dataset.id}'. Add it to 'datasets' in createSixb() or export it from 'datasets/'.`
        )
      }

      this.syncsById.set(sync.id, sync)
    }

    for (const pipeline of options.pipelines ?? []) {
      if (this.pipelinesById.has(pipeline.id)) {
        throw new RuntimeError(`Duplicate pipeline id: ${pipeline.id}`)
      }

      if (pipeline.graph.nodes.length === 0) {
        throw new RuntimeError(`Pipeline '${pipeline.id}' must contain at least one step.`)
      }

      const stepIds = new Set<string>()
      for (const node of pipeline.graph.nodes) {
        const { step } = node
        if (stepIds.has(step.id)) {
          throw new RuntimeError(
            `Pipeline '${pipeline.id}' contains duplicate step id '${step.id}'.`
          )
        }
        stepIds.add(step.id)

        for (const [inputName, dataset] of Object.entries(step.inputs)) {
          if (!this.datasetsById.has(dataset.id)) {
            throw new RuntimeError(
              `Pipeline '${pipeline.id}' step '${step.id}' input '${inputName}' references unknown dataset '${dataset.id}'. Add it to 'datasets' in createSixb() or export it from 'datasets/'.`
            )
          }
        }

        if (!this.datasetsById.has(step.output.id)) {
          throw new RuntimeError(
            `Pipeline '${pipeline.id}' step '${step.id}' outputs unknown dataset '${step.output.id}'. Add it to 'datasets' in createSixb() or export it from 'datasets/'.`
          )
        }
      }

      this.pipelinesById.set(pipeline.id, pipeline)
    }

    // Rules validate against the resolved ontology so inherited properties and
    // links are available before checking predicate references.
    validateRulesAtStartup(this.rules, this.ontology)
    for (const rule of this.rules) {
      this.rulesById.set(rule.id, rule)
    }

    validateSchedulesAtStartup([...this.schedulesById.values()], this.ontology, {
      registeredRuleIds: new Set(this.rulesById.keys()),
      registeredActionIds,
      registeredDatasetIds: new Set(this.datasetsById.keys()),
      registeredSyncIds: new Set(this.syncsById.keys()),
      registeredPipelineIds: new Set(this.pipelinesById.keys()),
    })
    for (const sync of this.syncsById.values()) {
      validateScheduleReferences("Sync", sync.id, sync.triggers, this.schedulesById)
    }
    for (const pipeline of this.pipelinesById.values()) {
      validateScheduleReferences("Pipeline", pipeline.id, pipeline.triggers, this.schedulesById)
    }

    const workflows = validateWorkflowsAtStartup({
      workflows: options.workflows ?? [],
      registeredSchedules: this.schedulesById,
      registeredActionIds,
      registeredAgentIds: new Set(agents.map((agent) => agent.id)),
    })

    const workflowIds = new Set<string>()
    for (const workflow of workflows) {
      if (workflowIds.has(workflow.id)) {
        throw new RuntimeError(`Duplicate workflow id: ${workflow.id}`)
      }
      workflowIds.add(workflow.id)
    }

    this.projectionRegistry = new ProjectionRegistry({
      projections: options.projections ?? [],
      ontology: this.ontology,
      datasetsById: this.datasetsById,
    })
    registerProjectionRegistry(this, this.projectionRegistry)

    const materializer = createOntologyMaterializer({
      projectId: this.projectId,
      ontology: this.ontology,
      projections: this.projectionRegistry,
      storage: this.storage,
    })
    this.committedFacts = new OntologyOutboxDispatcher({
      projectId: this.projectId,
      storage: this.storage,
      events: this.eventsRuntime,
      onDeliveryFailure: (error, failure) =>
        reportEventDeliveryFailure(errorReporter, error, {
          projectId: this.projectId,
          ...failure,
        }),
    })
    this.ontologyMaintenance = new OntologyMaintenance({
      projectId: this.projectId,
      storage: this.storage,
      dispatcher: this.committedFacts,
      options: options.ontologyMaintenance,
    })

    this.runtimeContext = {
      projectId: this.projectId,
      ontology: this.ontology,
      actionRegistry: this.actionRegistry,
      events: this.events,
      storage: this.storage,
      lakeStorage: this.lakeStorage,
      blobStorage: this.blobStorage,
      queues: this.queues,
      sandboxes: this.sandboxes,
      rules: this.rules,
    }
    registerProjectionRegistry(this.runtimeContext, this.projectionRegistry)
    const ontologyMutations = createOntologyMutationRuntime({
      materializer,
      notifyCommittedFacts: () => this.committedFacts.notify(),
    })
    registerOntologyMutationRuntime(this, ontologyMutations)
    registerOntologyMutationRuntime(this.runtimeContext, ontologyMutations)
    shareSixbErrorReporter(this, this.runtimeContext)
    this.actions = new ActionsRuntime(this.runtimeContext)
    this.workflows = new WorkflowsRuntime(this.runtimeContext, workflows)

    const agentIds = new Set<string>()
    for (const agent of agents) {
      if (agentIds.has(agent.id)) {
        throw new RuntimeError(`Duplicate agent id: ${agent.id}`)
      }
      agentIds.add(agent.id)
    }
    validateAgentGroupReferences(agents, this.security)
    this.agents = new AgentsRuntime(this.runtimeContext, agents)
  }

  get id(): string {
    return this.projectId
  }

  listObjectTypes(): readonly ObjectTypeWithPropertyTokens[] {
    return this.ontology.listObjectTypes()
  }

  getObjectTypeById(objectTypeId: string): ObjectTypeWithPropertyTokens | null {
    return this.ontology.getObjectTypeById(objectTypeId)
  }

  resolveObjectType(objectTypeId: string): ObjectTypeWithPropertyTokens {
    return this.ontology.resolveObjectType(objectTypeId)
  }

  getValueTypesById(): ReadonlyMap<string, ValueType> {
    return this.ontology.getValueTypesById()
  }

  listActions(): readonly ActionDefinition[] {
    return this.actionRegistry.list()
  }

  getActionById(actionId: string): ActionDefinition | null {
    return this.actionRegistry.getById(actionId)
  }

  listGlobalActions(): readonly ActionDefinition[] {
    return this.actionRegistry.getGlobalActions()
  }

  listActionsForType(objectType: ObjectType): readonly ActionDefinition[] {
    return this.actionRegistry.getActionsForType(objectType)
  }

  listDatasets(): readonly DatasetDefinition[] {
    return [...this.datasetsById.values()]
  }

  getDatasetById(datasetId: string): DatasetDefinition | null {
    return this.datasetsById.get(datasetId) ?? null
  }

  listSyncs(): readonly SyncDefinition[] {
    return [...this.syncsById.values()]
  }

  getSyncById(syncId: string): SyncDefinition | null {
    return this.syncsById.get(syncId) ?? null
  }

  listPipelines(): readonly PipelineDefinition[] {
    return [...this.pipelinesById.values()]
  }

  getPipelineById(pipelineId: string): PipelineDefinition | null {
    return this.pipelinesById.get(pipelineId) ?? null
  }

  // ── Starting work ─────────────────────────────────────────
  // Every verb is `request*` because everything here is queued, never run inline. `requestActionAndWait`
  // is the one that waits, and says so.

  requestAction(input: RequestActionInput): Promise<RequestActionResult> {
    return requestRuntimeAction(this.runtimeContext, input)
  }

  requestActionAndWait(input: RequestActionAndWaitInput): Promise<ActionRunRecord> {
    return requestRuntimeActionAndWait(this.runtimeContext, input)
  }

  requestWorkflowRun(input: RequestWorkflowRunInput): Promise<WorkflowRunRequestResult> {
    return this.workflows.requestById(input)
  }

  async requestSyncRun(input: RequestSyncRunInput): Promise<SyncRunRequestResult> {
    const sync = this.getSyncById(input.syncId)
    if (!sync) {
      throw new SyncValidationError(`[Sixb] Unknown sync '${input.syncId}'`)
    }
    return requestSyncRun(this.runtimeContext, sync, input)
  }

  async requestPipelineRun(input: RequestPipelineRunInput): Promise<PipelineRunRequestResult> {
    const pipeline = this.getPipelineById(input.pipelineId)
    if (!pipeline) {
      throw new PipelineError(`[Sixb] Unknown pipeline '${input.pipelineId}'`)
    }
    return requestPipelineRun(this.runtimeContext, pipeline, input)
  }

  requestAgentRun(input: RequestAgentRunInput): Promise<RequestAgentRunResult> {
    return this.agents.request(input)
  }

  listSchedules(): readonly ScheduleDefinition[] {
    return [...this.schedulesById.values()]
  }

  getScheduleById(scheduleId: string): ScheduleDefinition | null {
    return this.schedulesById.get(scheduleId) ?? null
  }

  listRules(): readonly RuleDefinition[] {
    return [...this.rulesById.values()]
  }

  getRuleById(ruleId: string): RuleDefinition | null {
    return this.rulesById.get(ruleId) ?? null
  }

  /** All connector definitions registered with this runtime. */
  listConnectors(): readonly ConnectorDefinition[] {
    return this.connectorRuntime.list()
  }

  /** Lookup a registered connector definition by id. */
  getConnectorById(connectorId: string): ConnectorDefinition | null {
    return this.connectorRuntime.getById(connectorId)
  }

  /** All webhook endpoints registered through connector adapters. */
  listWebhooks(): readonly RegisteredWebhook[] {
    return this.webhooks
  }

  /** Lookup a registered connector webhook by connector id and webhook id. */
  getWebhookById(connectorId: string, webhookId: string): RegisteredWebhook | null {
    return this.webhooksByRoute.get(webhookRoute(connectorId, webhookId)) ?? null
  }

  /**
   * Resolve a connector definition to a connected client.
   *
   * Connector definitions are inert. This method performs lazy connection and
   * reuses the same connected client for subsequent calls.
   */
  connector<TAdapter extends ConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>
  ): Promise<ConnectorClient<TAdapter>> {
    return this.connectorRuntime.connect(definition)
  }

  async startScheduler(): Promise<void> {
    if (this.schedulerRuntime || this.schedulesById.size === 0) return

    const runtime = new SchedulerRuntime({
      schedules: this.listSchedules(),
      events: this.eventsRuntime,
    })

    await runtime.start()
    this.schedulerRuntime = runtime
  }

  async stopScheduler(): Promise<void> {
    if (!this.schedulerRuntime) return

    const runtime = this.schedulerRuntime
    this.schedulerRuntime = null
    await runtime.stop()
  }

  /** Start the API-owned recovery and retention loop. Embedded runtimes opt in explicitly. */
  startOntologyMaintenance(): Promise<OntologyMaintenanceHandle> {
    this.storageReadiness.startSchemaValidation()
    return this.ontologyMaintenance.start()
  }

  getOntologyOperationalStatus(): OntologyOperationalStatus {
    return this.ontologyMaintenance.getOperationalStatus()
  }

  async checkReadiness(): Promise<SixbReadiness> {
    return this.storageReadiness.check()
  }

  /** Disconnect all currently connected connector clients. */
  async disconnectConnectors(): Promise<void> {
    await this.connectorRuntime.disconnectAll()
  }

  /** Flush and close the configured process logger provider. */
  async closeLogger(): Promise<void> {
    await this.logs.close()
  }

  /** Close the runtime broker provider if it owns external resources. */
  async closeBroker(): Promise<void> {
    await this.committedFacts.stop()
    await this.ontologyMaintenance.stop()
    await this.broker.close?.()
  }

  /**
   * Derive a principal-scoped SDK from this runtime.
   *
   * The scoped surface is default-deny: operations run only when covered by
   * the context's grants. This raw runtime stays privileged for trusted
   * system code (startup, syncs, projections, workers, webhooks, tests).
   */
  as(context: AuthorizationContext): ScopedSixb<TOntologySources> {
    return createScopedSixb<TOntologySources>(
      { ...this.runtimeContext, authorization: context },
      {
        datasets: {
          list: () => this.listDatasets(),
          getById: (datasetId) => this.getDatasetById(datasetId),
        },
        syncs: {
          list: () => this.listSyncs(),
          getById: (syncId) => this.getSyncById(syncId),
        },
        pipelines: {
          list: () => this.listPipelines(),
          getById: (pipelineId) => this.getPipelineById(pipelineId),
        },
        workflows: this.workflows,
        agents: this.agents,
      }
    )
  }

  objects<TObjectType extends RegisteredObjectType<TOntologySources>>(
    objectType: TObjectType
  ): ObjectSet<
    TObjectType,
    RegisteredValueTypes<TOntologySources>,
    RegisteredObjectType<TOntologySources>
  > {
    assertObjectTypeRegistered(this.ontology.getObjectTypesById(), objectType)

    return createObjectSet<
      TObjectType,
      RegisteredObjectType<TOntologySources>,
      RegisteredValueTypes<TOntologySources>
    >({ ...this.runtimeContext, objectType })
  }

  async upsertObject(
    objectTypeId: string,
    properties: Record<string, unknown>
  ): Promise<ObjectRow> {
    return objectService.upsertObject(this.runtimeContext, objectTypeId, properties)
  }

  async upsertObjectBatch(
    objectTypeId: string,
    items: readonly { properties: Record<string, unknown> }[]
  ): Promise<readonly BatchItemResult<ObjectRow>[]> {
    return objectService.upsertObjectBatch(this.runtimeContext, objectTypeId, items)
  }

  async upsertLinkBatch(
    items: readonly {
      objectTypeId: string
      sourceId: string
      linkId: string
      target: { targetTypeId: string; targetId: string; properties?: Record<string, unknown> }
    }[]
  ): Promise<readonly BatchItemResult<void>[]> {
    return objectService.upsertLinkBatch(this.runtimeContext, items)
  }

  async appendTelemetry(
    objectTypeId: string,
    items: readonly { id: string; properties: Record<string, unknown>; at?: Date }[]
  ): Promise<void> {
    await objectService.appendTelemetry(this.runtimeContext, objectTypeId, items)
  }

  async upsertLink(
    objectTypeId: string,
    sourceId: string,
    linkId: string,
    target: { targetTypeId: string; targetId: string; properties?: Record<string, unknown> }
  ): Promise<void> {
    await objectService.upsertLink(this.runtimeContext, objectTypeId, sourceId, linkId, target)
  }

  async removeLink(
    objectTypeId: string,
    sourceId: string,
    linkId: string,
    target: { targetTypeId: string; targetId: string }
  ): Promise<void> {
    await objectService.removeLink(this.runtimeContext, objectTypeId, sourceId, linkId, target)
  }

  getPrimaryPropertyId(objectTypeId: string): string {
    return this.ontology.getPrimaryPropertyId(objectTypeId)
  }

  listObjectProjections(): readonly ObjectProjectionDefinition[] {
    return this.projectionRegistry.listObjectProjections()
  }

  listLinkProjections(): readonly LinkProjectionDefinition[] {
    return this.projectionRegistry.listLinkProjections()
  }

  listTelemetryProjections(): readonly TelemetryProjectionDefinition[] {
    return this.projectionRegistry.listTelemetryProjections()
  }

  getProjectionById(projectionId: string): ProjectionDefinition | null {
    return this.projectionRegistry.getProjectionById(projectionId)
  }

  /**
   * Global list for cross-type queries (e.g., dashboards, search).
   * Use sixb.objects(Type).query().where(...).list() for type-safe property filtering.
   */
  async list(params: {
    objectTypeIds?: readonly string[]
    idPrefix?: string
    idSuffix?: string
    updatedAfter?: Date
    updatedBefore?: Date
    createdAfter?: Date
    createdBefore?: Date
    limit?: number
    offset?: number
    orderBy?: "createdAt" | "updatedAt" | "primaryId"
    order?: "asc" | "desc"
  }): Promise<ListResult<ObjectRow>> {
    return objectService.listObjects(this.runtimeContext, params)
  }

  listSubTypes(objectTypeId: string): string[] {
    return this.ontology.listSubTypes(objectTypeId)
  }

  isValidLinkTarget(expected: string | string[], actual: string): boolean {
    return this.ontology.isValidLinkTarget(expected, actual)
  }
}

function validateScheduleReferences(
  consumerKind: "Sync" | "Pipeline",
  consumerId: string,
  references: readonly { readonly scheduleId: string }[],
  schedulesById: ReadonlyMap<string, ScheduleDefinition>
): void {
  for (const reference of references) {
    if (!schedulesById.has(reference.scheduleId)) {
      throw new RuntimeError(
        `${consumerKind} '${consumerId}' references unknown schedule '${reference.scheduleId}'. Add it to 'schedules' in createSixb() or export it from 'schedules/'.`
      )
    }
  }
}

function validateAuthStrategySecurityReferences(
  strategy: ReturnType<AuthRuntime["getStrategy"]>,
  security: SecurityRegistry
): void {
  if (!isMagicLinkAuthStrategy(strategy) && !isOidcAuthStrategy(strategy)) {
    return
  }

  for (const groupId of strategy.bootstrapGroupIds ?? []) {
    if (!security.getGroupById(groupId)) {
      throw new AuthRuntimeError(
        "invalid_auth_config",
        `[Sixb] Auth bootstrapGroups references unknown group '${groupId}'. Add it to 'security/groups/' or pass it to createSixb({ groups }).`
      )
    }
  }
}

function assertWebhookDeliveryStorage(
  connectors: readonly ConnectorDefinition[],
  storage: Storage
): void {
  if (storage.webhookDeliveries !== undefined) {
    return
  }

  for (const connector of connectors) {
    const webhooks = connector.adapter.webhooks
    if (!Array.isArray(webhooks)) {
      continue
    }

    if (webhooks.some((webhook) => webhook.idempotencyKey !== undefined)) {
      throw new WebhookValidationError(
        "[Sixb] Webhook idempotency requires storage.webhookDeliveries to be configured."
      )
    }
  }
}
