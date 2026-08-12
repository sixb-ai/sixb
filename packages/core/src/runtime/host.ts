/**
 * SixbHost is the configured composition root.
 *
 * It owns providers, registered definitions, and process lifecycle. Domain operations live on a
 * {@link Sixb} SDK bound to one execution through {@link SixbHost.withScope}.
 */

import { resolve } from "node:path"
import type { ActionDefinition } from "../actions/types"
import type { AgentDefinition } from "../agents"
import {
  AuthRuntime,
  AuthRuntimeError,
  isMagicLinkAuthStrategy,
  isOidcAuthStrategy,
  type SixbAuthConfig,
} from "../auth"
import type { BlobStorage } from "../blob-storage"
import type { Broker } from "../broker"
import { ConnectorService } from "../connectors/service"
import type { ConnectorDefinition } from "../connectors/types"
import type { DatasetDefinition } from "../datasets/types"
import {
  attachSixbErrorReporter,
  reportEventDeliveryFailure,
  shareSixbErrorReporter,
} from "../error-reporting/capability"
import type { SixbErrorHandler } from "../error-reporting/types"
import {
  createDomainEventService,
  type DomainEventLog,
  type DomainEventService,
  OntologyOutboxDispatcher,
} from "../events"
import {
  assertExecutionScopeProject,
  resolveRuntimeAuthorization,
} from "../execution/authorization"
import type { ExecutionScope } from "../execution/types"
import type { LakeStorage } from "../lake-storage"
import { type LoggerProvider, LoggingService, type ObservabilityOptions } from "../logging"
import {
  OntologyMaintenance,
  type OntologyMaintenanceHandle,
  type OntologyMaintenanceOptions,
  type OntologyOperationalStatus,
  type SixbReadiness,
} from "../maintenance"
import { createOntologyMaterializer } from "../materializer"
import type { PipelineDefinition } from "../pipelines/types"
import { registerProjectionRegistry } from "../projections/internal"
import type { ProjectionDefinition } from "../projections/types"
import type { Queues } from "../queues"
import type { RuleDefinition } from "../rules"
import type { SandboxFactory } from "../sandboxes"
import { type SchedulerController, SchedulerRuntime } from "../scheduler"
import type { ScheduleDefinition } from "../schedules"
import type {
  GroupDefinition,
  MembershipPolicyDefinition,
  RoleDefinition,
  SecurityRegistry,
} from "../security"
import type { Storage } from "../storage"
import type { SyncDefinition } from "../syncs"
import type { RegisteredWebhook } from "../webhooks"
import { registerWebhooks, WebhookValidationError, webhookRoute } from "../webhooks"
import type { WorkflowDefinition } from "../workflows"
import type { SixbDefinitions } from "./definitions"
import {
  createOntologyMutationRuntime,
  registerOntologyMutationRuntime,
} from "./ontology-mutations"
import { resolveDefinitions } from "./resolve-definitions"
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
  /** Connector definitions registered with this host. */
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
  private readonly eventService: DomainEventService
  private readonly ontologyMaintenance: OntologyMaintenance
  private readonly storageReadiness: StorageReadiness
  private readonly connectorService: ConnectorService
  readonly definitions: SixbDefinitions
  readonly broker: Broker
  readonly events: DomainEventLog
  readonly logging: LoggingService
  readonly storage: Storage
  readonly lakeStorage: LakeStorage
  readonly blobStorage: BlobStorage
  readonly queues: Queues
  readonly sandboxes?: SandboxFactory
  readonly projectRoot: string
  readonly scheduler: SchedulerController
  readonly auth: AuthRuntime

  constructor(options: SixbHostOptions<TOntologySources>) {
    attachSixbErrorReporter(this, options.onError)
    this.projectId = options.id ?? "default"
    this.broker = options.broker
    // `host: this` is how `events.emit()` reaches the reporter attached at the top of this constructor.
    this.eventService = createDomainEventService({
      projectId: this.projectId,
      broker: this.broker,
      host: this,
    })
    this.events = this.eventService
    this.logging = new LoggingService({
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

    const definitions = resolveDefinitions(options)
    this.definitions = definitions
    registerProjectionRegistry(this, definitions.projections)

    this.auth = new AuthRuntime({
      projectId: this.projectId,
      storage: this.storage,
      security: definitions.security,
      config: options.auth,
    })
    validateAuthStrategySecurityReferences(this.auth.getStrategy(), definitions.security)
    const connectors = definitions.connectors.list()
    this.connectorService = new ConnectorService(this.projectId, connectors)
    assertWebhookDeliveryStorage(connectors, this.storage)
    this.webhooks = registerWebhooks(connectors).webhooks

    for (const registered of this.webhooks) {
      this.webhooksByRoute.set(registered.route, registered)
    }

    const materializer = createOntologyMaterializer({
      projectId: this.projectId,
      ontology: definitions.ontology,
      projections: definitions.projections,
      storage: this.storage,
    })
    this.committedFacts = new OntologyOutboxDispatcher({
      projectId: this.projectId,
      storage: this.storage,
      events: this.eventService,
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
      ontology: definitions.ontology,
      actionRegistry: definitions.actions,
      events: this.events,
      storage: this.storage,
      lakeStorage: this.lakeStorage,
      blobStorage: this.blobStorage,
      queues: this.queues,
      sandboxes: this.sandboxes,
      rules: definitions.rules.list(),
    }
    registerProjectionRegistry(this.hostContext, definitions.projections)
    const ontologyMutations = createOntologyMutationRuntime({
      materializer,
      notifyCommittedFacts: () => this.committedFacts.notify(),
    })
    registerOntologyMutationRuntime(this, ontologyMutations)
    registerOntologyMutationRuntime(this.hostContext, ontologyMutations)
    shareSixbErrorReporter(this, this.hostContext)
    this.scheduler = new SchedulerRuntime({
      schedules: definitions.schedules.list(),
      events: this.eventService,
    })
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
    await this.logging.close()
  }

  /** Disconnect every lazily created connector client. */
  async closeConnectors(): Promise<void> {
    await this.connectorService.close()
  }

  /** Close blob-provider resources owned by this host. */
  async closeBlobs(): Promise<void> {
    await this.blobStorage.close?.()
  }

  /** Close the runtime broker provider if it owns external resources. */
  async closeBroker(): Promise<void> {
    await this.committedFacts.stop()
    await this.ontologyMaintenance.stop()
    await this.broker.close?.()
  }

  private sixbDependencies(): SixbDependencies {
    return {
      definitions: this.definitions,
      logging: this.logging,
      connectorService: this.connectorService,
      blobStorage: this.blobStorage,
    }
  }
}

/**
 * Ontology-agnostic host view for infrastructure that only composes providers and execution
 * boundaries. Authoring code should retain {@link SixbHost}'s inferred ontology parameter; CLI,
 * server, and worker infrastructure deliberately do not depend on it.
 */
export type SixbHostView = Omit<SixbHost, "withScope"> & {
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
