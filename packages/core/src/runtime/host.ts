/**
 * SixbHost is the configured composition root.
 *
 * It owns providers, registered definitions, and process lifecycle. Domain operations live on a
 * {@link Sixb} SDK bound to one execution through {@link SixbHost.withScope}.
 */

import { resolve } from "node:path"
import { type ActionRegistry, type ActionsRuntime, createActionsRuntime } from "../actions"
import type { ActionDefinition } from "../actions/types"
import type { AgentDefinition, AgentsRuntime } from "../agents"
import { createAgentsRuntime } from "../agents"
import {
  AuthRuntime,
  AuthRuntimeError,
  isMagicLinkAuthStrategy,
  isOidcAuthStrategy,
  type SixbAuthConfig,
} from "../auth"
import type { BlobStorage, BlobsRuntime } from "../blob-storage"
import { createBlobsRuntime } from "../blob-storage/runtime"
import type { Broker } from "../broker"
import {
  type ConnectorRuntime,
  type ConnectorsRuntime,
  createConnectorsRuntime,
} from "../connectors/runtime"
import type { ConnectorDefinition } from "../connectors/types"
import { createDatasetsRuntime, type DatasetsRuntime } from "../datasets"
import type { DatasetDefinition } from "../datasets/types"
import {
  attachSixbErrorReporter,
  reportEventDeliveryFailure,
  shareSixbErrorReporter,
} from "../error-reporting/capability"
import type { SixbErrorHandler } from "../error-reporting/types"
import {
  createEventsRuntime,
  type DomainEventLog,
  type EventsRuntime,
  OntologyOutboxDispatcher,
} from "../events"
import {
  assertExecutionScopeProject,
  resolveRuntimeAuthorization,
} from "../execution/authorization"
import type { ExecutionScope } from "../execution/types"
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
import { createObjectTypesRuntime, type ObjectTypesRuntime } from "../objects"
import type { OntologyRegistry } from "../ontology"
import { createPipelinesRuntime, type PipelinesRuntime } from "../pipelines"
import type { PipelineDefinition } from "../pipelines/types"
import { registerProjectionRegistry } from "../projections/internal"
import { createProjectionsRuntime, type ProjectionsRuntime } from "../projections/runtime"
import type { ProjectionDefinition } from "../projections/types"
import type { Queues } from "../queues"
import { createRulesRuntime, type RuleDefinition, type RulesRuntime } from "../rules"
import type { SandboxFactory } from "../sandboxes"
import {
  createSchedulesRuntime,
  type ScheduleDefinition,
  type SchedulesRuntime,
} from "../schedules"
import type {
  GroupDefinition,
  MembershipPolicyDefinition,
  RoleDefinition,
  SecurityRegistry,
} from "../security"
import type { Storage } from "../storage"
import type { SyncDefinition } from "../syncs"
import { createSyncsRuntime, type SyncsRuntime } from "../syncs"
import type { RegisteredWebhook } from "../webhooks"
import { registerWebhooks, WebhookValidationError, webhookRoute } from "../webhooks"
import type { WorkflowDefinition, WorkflowsRuntime } from "../workflows"
import { createWorkflowsRuntime } from "../workflows"
import {
  createOntologyMutationRuntime,
  registerOntologyMutationRuntime,
} from "./ontology-mutations"
import { resolveRuntimeDefinitions } from "./resolve-definitions"
import { createBoundSixb, type Sixb, type SixbDependencies } from "./sixb"
import { StorageReadiness } from "./storage-readiness"
import type { OntologySource, SixbHostContext, SixbRuntimeContext } from "./types"

export interface SixbHostOptions<TOntologySources extends readonly OntologySource[]> {
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

export class SixbHost<
  TOntologySources extends readonly OntologySource[] = readonly OntologySource[],
> {
  readonly projectId: string
  private readonly webhooksByRoute = new Map<string, RegisteredWebhook>()
  private readonly webhooks: readonly RegisteredWebhook[]
  private readonly hostContext: SixbHostContext
  private readonly committedFacts: OntologyOutboxDispatcher
  private readonly eventsRuntime: EventsRuntime
  private readonly ontologyMaintenance: OntologyMaintenance
  private readonly storageReadiness: StorageReadiness
  readonly ontology: OntologyRegistry
  readonly actionRegistry: ActionRegistry
  readonly objects: ObjectTypesRuntime
  readonly actions: ActionsRuntime
  readonly workflows: WorkflowsRuntime
  readonly agents: AgentsRuntime
  readonly datasets: DatasetsRuntime
  readonly syncs: SyncsRuntime
  readonly pipelines: PipelinesRuntime
  readonly connector: ConnectorRuntime
  readonly connectors: ConnectorsRuntime
  readonly blobs: BlobsRuntime
  readonly broker: Broker
  readonly events: DomainEventLog
  readonly logs: LogsRuntime
  readonly storage: Storage
  readonly lakeStorage: LakeStorage
  readonly queues: Queues
  readonly sandboxes?: SandboxFactory
  readonly projectRoot: string
  readonly schedules: SchedulesRuntime
  readonly rules: RulesRuntime
  readonly projections: ProjectionsRuntime
  readonly security: SecurityRegistry
  readonly auth: AuthRuntime

  constructor(options: SixbHostOptions<TOntologySources>) {
    attachSixbErrorReporter(this, options.onError)
    this.projectId = options.id ?? "default"
    this.broker = options.broker
    // `host: this` is how `events.emit()` reaches the reporter attached at the top of this constructor.
    this.eventsRuntime = createEventsRuntime({
      projectId: this.projectId,
      broker: this.broker,
      host: this,
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
    this.blobs = createBlobsRuntime(options.blobStorage)
    this.queues = options.queues
    this.sandboxes = options.sandboxes
    this.projectRoot = resolve(options.projectRoot ?? process.cwd())

    const definitions = resolveRuntimeDefinitions(options)
    this.ontology = definitions.ontology
    this.actionRegistry = definitions.actionRegistry
    this.security = definitions.security
    this.rules = createRulesRuntime(definitions.rules)
    this.projections = createProjectionsRuntime(definitions.projectionRegistry)
    registerProjectionRegistry(this, definitions.projectionRegistry)

    this.auth = new AuthRuntime({
      projectId: this.projectId,
      storage: this.storage,
      security: this.security,
      config: options.auth,
    })
    validateAuthStrategySecurityReferences(this.auth.getStrategy(), this.security)
    const connectorRuntimes = createConnectorsRuntime(this.projectId, options.connectors ?? [])
    this.connector = connectorRuntimes.connector
    this.connectors = connectorRuntimes.connectors
    const connectors = this.connectors.list()
    assertWebhookDeliveryStorage(connectors, this.storage)
    this.webhooks = registerWebhooks(connectors).webhooks

    for (const registered of this.webhooks) {
      this.webhooksByRoute.set(registered.route, registered)
    }

    const materializer = createOntologyMaterializer({
      projectId: this.projectId,
      ontology: this.ontology,
      projections: definitions.projectionRegistry,
      storage: this.storage,
    })
    this.committedFacts = new OntologyOutboxDispatcher({
      projectId: this.projectId,
      storage: this.storage,
      events: this.eventsRuntime,
      onDeliveryFailure: (error, failure) =>
        reportEventDeliveryFailure(this, error, {
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

    this.hostContext = {
      projectId: this.projectId,
      ontology: this.ontology,
      actionRegistry: this.actionRegistry,
      events: this.events,
      storage: this.storage,
      lakeStorage: this.lakeStorage,
      blobStorage: this.blobs,
      queues: this.queues,
      sandboxes: this.sandboxes,
      rules: this.rules.list(),
    }
    registerProjectionRegistry(this.hostContext, definitions.projectionRegistry)
    const ontologyMutations = createOntologyMutationRuntime({
      materializer,
      notifyCommittedFacts: () => this.committedFacts.notify(),
    })
    registerOntologyMutationRuntime(this, ontologyMutations)
    registerOntologyMutationRuntime(this.hostContext, ontologyMutations)
    shareSixbErrorReporter(this, this.hostContext)
    this.objects = createObjectTypesRuntime(this.hostContext)
    this.actions = createActionsRuntime(this.actionRegistry)
    this.schedules = createSchedulesRuntime(definitions.schedules, this.eventsRuntime)
    this.datasets = createDatasetsRuntime(definitions.datasets)
    this.syncs = createSyncsRuntime(definitions.syncs)
    this.pipelines = createPipelinesRuntime(definitions.pipelines)
    this.workflows = createWorkflowsRuntime(definitions.workflows)
    this.agents = createAgentsRuntime(definitions.agents)
  }

  /** Bind an existing opaque scope. This method never creates or escalates authority. */
  withScope(scope: ExecutionScope): Sixb<TOntologySources> {
    assertExecutionScopeProject(this.projectId, scope)
    const authorization = resolveRuntimeAuthorization(scope.authorization)
    if (authorization.type === "denied") {
      throw new Error("[Sixb] Execution scope carries unregistered runtime authorization.")
    }
    if (authorization.ref.type === "kernel") {
      throw new Error("[Sixb] Kernel authority cannot be bound to the domain SDK.")
    }

    const runtime: SixbRuntimeContext = {
      ...this.hostContext,
      runtimeAuthorization: scope.authorization,
      ...(authorization.type === "principal" ? { authorization: authorization.context } : {}),
    }
    return createBoundSixb<TOntologySources>(runtime, this.sixbDependencies(), scope.execution)
  }

  get id(): string {
    return this.projectId
  }

  /** All webhook endpoints registered through connector adapters. */
  listWebhooks(): readonly RegisteredWebhook[] {
    return this.webhooks
  }

  /** Lookup a registered connector webhook by connector id and webhook id. */
  getWebhookById(connectorId: string, webhookId: string): RegisteredWebhook | null {
    return this.webhooksByRoute.get(webhookRoute(connectorId, webhookId)) ?? null
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

  private sixbDependencies(): SixbDependencies {
    return {
      datasets: this.datasets,
      syncs: this.syncs,
      pipelines: this.pipelines,
      projections: this.projections,
      rules: this.rules,
      workflows: this.workflows,
      agents: this.agents,
      logs: this.logs,
      schedules: this.schedules,
      connector: this.connector,
      connectors: this.connectors,
      blobs: this.blobs,
    }
  }
}

/**
 * Ontology-agnostic host view for infrastructure that only composes providers and execution
 * boundaries. Authoring code should retain {@link SixbHost}'s inferred ontology parameter; CLI,
 * server, and worker infrastructure deliberately do not depend on it.
 */
export type SixbHostRuntime = Omit<SixbHost, "withScope"> & {
  withScope(scope: ExecutionScope): object
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
