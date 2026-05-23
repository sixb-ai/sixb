/**
 * Pario is the main runtime entry point.
 *
 * It provides a typed API (`objects(MyType)`) returning ObjectSet with full compile-time inference.
 * For direct runtime access (broker records, events, storage, queued work), use
 * `pario.broker`, `pario.events`, `pario.storage`, and `pario.queues`.
 */

import { ActionRegistry } from "../actions"
import type { ActionDefinition } from "../actions/types"
import {
  AuthRuntimeError,
  isMagicLinkAuthStrategy,
  isOidcAuthStrategy,
  type ParioAuthConfig,
  ParioAuthRuntime,
} from "../auth"
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
import { createObjectSet, objectService } from "../objects"
import { assertObjectTypeRegistered, type ObjectType, OntologyRegistry } from "../ontology"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import type { PipelineDefinition } from "../pipelines/types"
import { categorizeProjections } from "../projections/builders"
import type {
  LinkProjectionDefinition,
  ObjectProjectionDefinition,
  ProjectionDefinition,
} from "../projections/types"
import { validateProjectionsAtStartup } from "../projections/validation"
import type { Queues } from "../queues"
import type { RuleDefinition } from "../rules"
import { validateRulesAtStartup } from "../rules"
import { SchedulerRuntime } from "../scheduler"
import type { ScheduleDefinition } from "../schedules"
import type { GroupDefinition, InvitePolicyDefinition, SecurityRegistry } from "../security"
import { createRuntimeSecurityRegistry } from "../security/runtime"
import type { ObjectRow, Storage } from "../storage"
import type { SyncDefinition } from "../syncs"
import type { RegisteredWebhook } from "../webhooks"
import { registerWebhooks, WebhookValidationError, webhookRoute } from "../webhooks"
import type { WorkflowDefinition } from "../workflows"
import { validateWorkflowsAtStartup } from "../workflows"
import { RuntimeError } from "./errors"
import type {
  BatchItemResult,
  ListResult,
  ObjectSet,
  OntologySource,
  ParioInstance,
  ParioRuntimeContext,
  RegisteredObjectType,
  RegisteredValueTypes,
} from "./types"

export interface ParioOptions<TOntologySources extends readonly OntologySource[]> {
  id?: string
  ontology: TOntologySources
  broker: Broker
  storage: Storage
  lakeStorage: LakeStorage
  blobStorage: BlobStorage
  queues: Queues
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
  groups?: readonly GroupDefinition[]
  invitePolicies?: readonly InvitePolicyDefinition[]
  auth?: ParioAuthConfig
}

export class Pario<TOntologySources extends readonly OntologySource[]>
  implements ParioInstance<TOntologySources>
{
  readonly projectId: string
  private readonly ontologySources: TOntologySources
  private readonly functions: readonly FunctionDefinition[]
  private readonly datasetsById = new Map<string, DatasetDefinition>()
  private readonly schedulesById = new Map<string, ScheduleDefinition>()
  private readonly syncsById = new Map<string, SyncDefinition>()
  private readonly pipelinesById = new Map<string, PipelineDefinition>()
  private readonly rulesById = new Map<string, RuleDefinition>()
  private readonly workflowsById = new Map<string, WorkflowDefinition>()
  private readonly connectorRuntime: ConnectorRuntime
  private readonly webhooksByRoute = new Map<string, RegisteredWebhook>()
  private readonly webhooks: readonly RegisteredWebhook[]
  private readonly runtimeContext: ParioRuntimeContext
  private readonly objectProjections: readonly ObjectProjectionDefinition[]
  private readonly linkProjections: readonly LinkProjectionDefinition[]
  private readonly projectionsById = new Map<string, ProjectionDefinition>()
  readonly ontology: OntologyRegistry
  readonly actionRegistry: ActionRegistry
  readonly broker: Broker
  readonly events: EventsRuntime
  readonly storage: Storage
  readonly lakeStorage: LakeStorage
  readonly blobStorage: BlobStorage
  readonly queues: Queues
  readonly rules: readonly RuleDefinition[]
  readonly security: SecurityRegistry
  readonly auth: ParioAuthRuntime
  private functionRuntime: FunctionRuntime | null = null
  private schedulerRuntime: SchedulerRuntime | null = null

  constructor(options: ParioOptions<TOntologySources>) {
    this.projectId = options.id ?? "default"
    this.ontologySources = options.ontology
    this.functions = options.functions ?? []
    this.broker = options.broker
    this.events = new EventsRuntime({ projectId: this.projectId, broker: this.broker })
    this.storage = options.storage
    this.lakeStorage = options.lakeStorage
    this.blobStorage = options.blobStorage
    this.queues = options.queues
    this.rules = options.rules ?? []
    this.security = createRuntimeSecurityRegistry({
      groups: options.groups ?? [],
      invitePolicies: options.invitePolicies ?? [],
    })
    this.auth = new ParioAuthRuntime({
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
          `Sync '${sync.id}' targets unknown dataset '${sync.target.dataset.id}'. Add it to 'datasets' in createPario() or export it from 'datasets/'.`
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
              `Pipeline '${pipeline.id}' step '${step.id}' input '${inputName}' references unknown dataset '${dataset.id}'. Add it to 'datasets' in createPario() or export it from 'datasets/'.`
            )
          }
        }

        if (!this.datasetsById.has(step.output.id)) {
          throw new RuntimeError(
            `Pipeline '${pipeline.id}' step '${step.id}' outputs unknown dataset '${step.output.id}'. Add it to 'datasets' in createPario() or export it from 'datasets/'.`
          )
        }
      }

      this.pipelinesById.set(pipeline.id, pipeline)
    }

    this.ontology = new OntologyRegistry({ sources: this.ontologySources })
    this.actionRegistry = new ActionRegistry(options.actions ?? [], this.ontology)

    // Rules validate against the resolved ontology so inherited properties and
    // links are available before checking predicate references.
    validateRulesAtStartup(this.rules, this.ontology)
    for (const rule of this.rules) {
      this.rulesById.set(rule.id, rule)
    }

    const workflows = validateWorkflowsAtStartup({
      workflows: options.workflows ?? [],
      registeredScheduleIds: new Set(this.schedulesById.keys()),
      registeredActionIds: new Set(this.actionRegistry.list().map((action) => action.id)),
    })

    for (const workflow of workflows) {
      if (this.workflowsById.has(workflow.id)) {
        throw new RuntimeError(`Duplicate workflow id: ${workflow.id}`)
      }
      this.workflowsById.set(workflow.id, workflow)
    }
    this.runtimeContext = {
      projectId: this.projectId,
      ontology: this.ontology,
      actionRegistry: this.actionRegistry,
      events: this.events,
      storage: this.storage,
      lakeStorage: this.lakeStorage,
      blobStorage: this.blobStorage,
      queues: this.queues,
    }

    const { objectProjections, linkProjections } = categorizeProjections(options.projections ?? [])
    this.objectProjections = objectProjections
    this.linkProjections = linkProjections
    for (const projection of [...objectProjections, ...linkProjections]) {
      if (this.projectionsById.has(projection.id)) {
        throw new RuntimeError(`Duplicate projection id: ${projection.id}`)
      }
      this.projectionsById.set(projection.id, projection)
    }
    validateProjectionsAtStartup(
      objectProjections,
      linkProjections,
      this.ontology,
      this.datasetsById
    )
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

  getFunctionDefinitions(): readonly FunctionDefinition[] {
    return this.functions
  }

  getActionDefinitions(): readonly ActionDefinition[] {
    return this.actionRegistry.list()
  }

  getActionById(actionId: string): ActionDefinition | null {
    return this.actionRegistry.getById(actionId)
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

  getWorkflowDefinitions(): readonly WorkflowDefinition[] {
    return [...this.workflowsById.values()]
  }

  getWorkflowById(workflowId: string): WorkflowDefinition | null {
    return this.workflowsById.get(workflowId) ?? null
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
      // Boundary cast: TS class generic invariance — `Pario<TOntologySources>` is not
      // assignable to `Pario<readonly OntologySource[]>`, even though the runtime is
      // structurally compatible.
      pario: this as unknown as Pario<readonly OntologySource[]>,
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

  /** Close the runtime broker provider if it owns external resources. */
  async closeBroker(): Promise<void> {
    await this.broker.close?.()
  }

  objects<TObjectType extends RegisteredObjectType<TOntologySources>>(
    objectType: TObjectType
  ): ObjectSet<TObjectType, RegisteredValueTypes<TOntologySources>> {
    assertObjectTypeRegistered(this.ontology.getObjectTypesById(), objectType)

    return createObjectSet<TObjectType, RegisteredValueTypes<TOntologySources>>({
      objectType,
      projectId: this.projectId,
      ontology: this.ontology,
      actionRegistry: this.actionRegistry,
      events: this.events,
      lakeStorage: this.lakeStorage,
      blobStorage: this.blobStorage,
      storage: this.storage,
      queues: this.queues,
    })
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

  async requestAction(
    objectTypeId: string,
    id: string,
    actionId: string,
    params?: Record<string, unknown>,
    options?: { runId?: string }
  ): Promise<{ runId: string }> {
    return objectService.requestAction(
      this.runtimeContext,
      objectTypeId,
      id,
      actionId,
      params,
      options
    )
  }

  async requestActionAndWait(
    objectTypeId: string,
    id: string,
    actionId: string,
    params?: Record<string, unknown>,
    options?: { runId?: string; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<{ runId: string }> {
    return objectService.requestActionAndWait(
      this.runtimeContext,
      objectTypeId,
      id,
      actionId,
      params,
      options
    )
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

  getProjectionById(projectionId: string): ProjectionDefinition | null {
    return this.projectionsById.get(projectionId) ?? null
  }

  /**
   * Global list for cross-type queries (e.g., dashboards, search).
   * Use pario.objects(Type).list() for type-safe property filtering.
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
    const expandedTypeIds = params.objectTypeIds
      ? [...new Set(params.objectTypeIds.flatMap((id) => [id, ...this.ontology.getSubTypes(id)]))]
      : undefined

    const result = await this.storage.objects.list({
      projectId: this.projectId,
      objectTypeId: expandedTypeIds?.length === 1 ? expandedTypeIds[0] : expandedTypeIds,
      primaryIdPrefix: params.idPrefix,
      primaryIdSuffix: params.idSuffix,
      updatedAfter: params.updatedAfter,
      updatedBefore: params.updatedBefore,
      createdAfter: params.createdAfter,
      createdBefore: params.createdBefore,
      limit: params.limit,
      offset: params.offset,
      orderBy: params.orderBy,
      order: params.order,
    })

    return {
      objects: [...result.objects],
      hasMore: result.hasMore,
      total: result.total,
    }
  }

  getSubTypes(objectTypeId: string): string[] {
    return this.ontology.getSubTypes(objectTypeId)
  }

  isValidLinkTarget(expected: string | string[], actual: string): boolean {
    return this.ontology.isValidLinkTarget(expected, actual)
  }
}

function validateAuthStrategySecurityReferences(
  strategy: ReturnType<ParioAuthRuntime["getStrategy"]>,
  security: SecurityRegistry
): void {
  if (!isMagicLinkAuthStrategy(strategy) && !isOidcAuthStrategy(strategy)) {
    return
  }

  for (const groupId of strategy.bootstrapGroupIds ?? []) {
    if (!security.getGroupById(groupId)) {
      throw new AuthRuntimeError(
        "invalid_auth_config",
        `[Pario] Auth bootstrapGroups references unknown group '${groupId}'. Add it to 'security/groups/' or pass it to createPario({ groups }).`
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
        "[Pario] Webhook idempotency requires storage.webhookDeliveries to be configured."
      )
    }
  }
}
