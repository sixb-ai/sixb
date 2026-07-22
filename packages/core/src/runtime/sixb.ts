/**
 * Sixb is the main runtime entry point.
 *
 * It provides a typed API (`objects(MyType)`) returning ObjectSet with full compile-time inference.
 * For direct runtime access (broker records, events, storage, queued work), use
 * `sixb.broker`, `sixb.events`, `sixb.storage`, and `sixb.queues`.
 */

import { resolve } from "node:path"
import { ActionRegistry, ActionsRuntime } from "../actions"
import type { ActionDefinition } from "../actions/types"
import type { AgentDefinition } from "../agents"
import { AgentsRuntime, validateAgentGroupReferences } from "../agents"
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
import { EventsRuntime } from "../events"
import { FunctionRuntime } from "../functions/runtime"
import type { FunctionDefinition } from "../functions/types"
import type { LakeStorage } from "../lake-storage"
import { type LoggerProvider, LogsRuntime, type ObservabilityOptions } from "../logging"
import { createObjectSet, objectService } from "../objects"
import {
  assertObjectTypeRegistered,
  type ObjectType,
  OntologyRegistry,
  type ValueType,
} from "../ontology"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import type { PipelineDefinition } from "../pipelines/types"
import { categorizeProjections } from "../projections/builders"
import type {
  LinkProjectionDefinition,
  ObjectProjectionDefinition,
  ProjectionDefinition,
  TelemetryProjectionDefinition,
} from "../projections/types"
import { validateProjectionsAtStartup } from "../projections/validation"
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
import type { ObjectRow, Storage } from "../storage"
import type { SyncDefinition } from "../syncs"
import type { RegisteredWebhook } from "../webhooks"
import { registerWebhooks, WebhookValidationError, webhookRoute } from "../webhooks"
import type { WorkflowDefinition } from "../workflows"
import { validateWorkflowsAtStartup, WorkflowsRuntime } from "../workflows"
import { RuntimeError } from "./errors"
import { createScopedSixb, type ScopedSixb } from "./scoped"
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
  projectRoot?: string
  actions?: readonly ActionDefinition[]
  datasets?: readonly DatasetDefinition[]
  /** Connector definitions registered with this runtime. */
  connectors?: readonly ConnectorDefinition[]
  functions?: readonly FunctionDefinition[]
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
  private readonly functions: readonly FunctionDefinition[]
  private readonly datasetsById = new Map<string, DatasetDefinition>()
  private readonly schedulesById = new Map<string, ScheduleDefinition>()
  private readonly syncsById = new Map<string, SyncDefinition>()
  private readonly pipelinesById = new Map<string, PipelineDefinition>()
  private readonly rulesById = new Map<string, RuleDefinition>()
  private readonly connectorRuntime: ConnectorRuntime
  private readonly webhooksByRoute = new Map<string, RegisteredWebhook>()
  private readonly webhooks: readonly RegisteredWebhook[]
  private readonly runtimeContext: SixbRuntimeContext
  private readonly objectProjections: readonly ObjectProjectionDefinition[]
  private readonly linkProjections: readonly LinkProjectionDefinition[]
  private readonly telemetryProjections: readonly TelemetryProjectionDefinition[]
  private readonly projectionsById = new Map<string, ProjectionDefinition>()
  readonly ontology: OntologyRegistry
  readonly actionRegistry: ActionRegistry
  readonly actions: ActionsRuntime
  readonly workflows: WorkflowsRuntime
  readonly agents: AgentsRuntime
  readonly broker: Broker
  readonly events: EventsRuntime
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
  private functionRuntime: FunctionRuntime | null = null
  private schedulerRuntime: SchedulerRuntime | null = null

  constructor(options: SixbOptions<TOntologySources>) {
    this.projectId = options.id ?? "default"
    this.ontologySources = options.ontology
    this.functions = options.functions ?? []
    this.broker = options.broker
    this.events = new EventsRuntime({ projectId: this.projectId, broker: this.broker })
    this.logs = new LogsRuntime({
      projectId: this.projectId,
      broker: this.broker,
      logger: options.logger,
      observability: options.observability?.logs,
    })
    this.storage = options.storage
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
      getSubTypes: (objectTypeId) => this.ontology.getSubTypes(objectTypeId),
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
    })

    const workflowIds = new Set<string>()
    for (const workflow of workflows) {
      if (workflowIds.has(workflow.id)) {
        throw new RuntimeError(`Duplicate workflow id: ${workflow.id}`)
      }
      workflowIds.add(workflow.id)
    }

    const { objectProjections, linkProjections, telemetryProjections } = categorizeProjections(
      options.projections ?? []
    )
    this.objectProjections = objectProjections
    this.linkProjections = linkProjections
    this.telemetryProjections = telemetryProjections
    for (const projection of [...objectProjections, ...linkProjections, ...telemetryProjections]) {
      if (this.projectionsById.has(projection.id)) {
        throw new RuntimeError(`Duplicate projection id: ${projection.id}`)
      }
      this.projectionsById.set(projection.id, projection)
    }
    validateProjectionsAtStartup(
      objectProjections,
      linkProjections,
      telemetryProjections,
      this.ontology,
      this.datasetsById
    )

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

  getFunctionDefinitions(): readonly FunctionDefinition[] {
    return this.functions
  }

  getActionDefinitions(): readonly ActionDefinition[] {
    return this.actionRegistry.list()
  }

  getActionById(actionId: string): ActionDefinition | null {
    return this.actionRegistry.getById(actionId)
  }

  getGlobalActions(): readonly ActionDefinition[] {
    return this.actionRegistry.getGlobalActions()
  }

  getActionsForType(objectType: ObjectType): readonly ActionDefinition[] {
    return this.actionRegistry.getActionsForType(objectType)
  }

  getDatasetDefinitions(): readonly DatasetDefinition[] {
    return [...this.datasetsById.values()]
  }

  getDatasetById(datasetId: string): DatasetDefinition | null {
    return this.datasetsById.get(datasetId) ?? null
  }

  getSyncDefinitions(): readonly SyncDefinition[] {
    return [...this.syncsById.values()]
  }

  getSyncById(syncId: string): SyncDefinition | null {
    return this.syncsById.get(syncId) ?? null
  }

  getPipelineDefinitions(): readonly PipelineDefinition[] {
    return [...this.pipelinesById.values()]
  }

  getPipelineById(pipelineId: string): PipelineDefinition | null {
    return this.pipelinesById.get(pipelineId) ?? null
  }

  getScheduleDefinitions(): readonly ScheduleDefinition[] {
    return [...this.schedulesById.values()]
  }

  getScheduleById(scheduleId: string): ScheduleDefinition | null {
    return this.schedulesById.get(scheduleId) ?? null
  }

  getRuleDefinitions(): readonly RuleDefinition[] {
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

  async startFunctions(): Promise<void> {
    if (this.functionRuntime || this.functions.length === 0) {
      return
    }

    const runtime = new FunctionRuntime({
      // Boundary cast: TS class generic invariance — `Sixb<TOntologySources>` is not
      // assignable to `Sixb<readonly OntologySource[]>`, even though the runtime is
      // structurally compatible.
      sixb: this as unknown as Sixb<readonly OntologySource[]>,
      functions: this.functions,
    })

    await runtime.start()
    this.functionRuntime = runtime
  }

  async stopFunctions(): Promise<void> {
    if (!this.functionRuntime) {
      return
    }

    const runtime = this.functionRuntime
    this.functionRuntime = null
    await runtime.stop()
  }

  async startScheduler(): Promise<void> {
    if (this.schedulerRuntime || this.schedulesById.size === 0) return

    const runtime = new SchedulerRuntime({
      schedules: this.getScheduleDefinitions(),
      events: this.events,
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
          list: () => this.getDatasetDefinitions(),
          getById: (datasetId) => this.getDatasetById(datasetId),
        },
        syncs: {
          list: () => this.getSyncDefinitions(),
          getById: (syncId) => this.getSyncById(syncId),
        },
        pipelines: {
          list: () => this.getPipelineDefinitions(),
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

  getObjectProjections(): readonly ObjectProjectionDefinition[] {
    return this.objectProjections
  }

  getLinkProjections(): readonly LinkProjectionDefinition[] {
    return this.linkProjections
  }

  getTelemetryProjections(): readonly TelemetryProjectionDefinition[] {
    return this.telemetryProjections
  }

  getProjectionById(projectionId: string): ProjectionDefinition | null {
    return this.projectionsById.get(projectionId) ?? null
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

  getSubTypes(objectTypeId: string): string[] {
    return this.ontology.getSubTypes(objectTypeId)
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
