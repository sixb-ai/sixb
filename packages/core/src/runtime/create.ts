import { resolve } from "node:path"
import type { ActionDefinition } from "../actions"
import type { AgentDefinition } from "../agents"
import type { SixbAuthConfig } from "../auth"
import type { BlobStorage } from "../blob-storage"
import { discoverOntologySources, discoverProjectDefinitions } from "../bootstrap"
import type { Broker } from "../broker"
import type { ConnectorConnectionOptions, ConnectorDefinition } from "../connectors/types"
import type { DatasetDefinition } from "../datasets"
import type { SixbErrorHandler } from "../error-reporting/types"
import type { LakeStorage } from "../lake-storage"
import type { LoggerProvider, ObservabilityOptions } from "../logging"
import type { OntologyMaintenanceOptions } from "../maintenance"
import type { PipelineDefinition } from "../pipelines/types"
import type { ProjectionDefinition } from "../projections/types"
import type { Queues } from "../queues"
import type { RuleDefinition } from "../rules"
import type { SandboxFactory } from "../sandboxes"
import type { ScheduleDefinition } from "../schedules"
import type { GroupDefinition, MembershipPolicyDefinition, RoleDefinition } from "../security"
import type { Storage } from "../storage"
import type { SyncDefinition } from "../syncs"
import type { WorkflowDefinition } from "../workflows"
import { RuntimeError } from "./errors"
import { SixbHost } from "./host"
import type { OntologySource } from "./types"

export interface CreateSixbOptions {
  id?: string
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
  ontologies?: readonly OntologySource[]
  actions?: readonly ActionDefinition[]
  /** Agent definitions to register in addition to auto-discovered `agents/` exports. */
  agents?: readonly AgentDefinition[]
  datasets?: readonly DatasetDefinition[]
  /** Connector definitions to register in addition to auto-discovered `connectors/` exports. */
  connectors?: readonly ConnectorDefinition[]
  /** Required to protect OAuth credentials when connector connection storage is durable. */
  connectorConnections?: ConnectorConnectionOptions
  schedules?: readonly ScheduleDefinition[]
  syncs?: readonly SyncDefinition[]
  pipelines?: readonly PipelineDefinition[]
  projections?: readonly ProjectionDefinition[]
  rules?: readonly RuleDefinition[]
  workflows?: readonly WorkflowDefinition[]
  groups?: readonly GroupDefinition[]
  roles?: readonly RoleDefinition[]
  membershipPolicies?: readonly MembershipPolicyDefinition[]
  auth?: SixbAuthConfig
  projectRoot?: string
}

/**
 * Create a SixbHost using convention-based discovery.
 *
 * The host auto-discovers exported definitions from `ontology/`, `actions/`, `datasets/`,
 * `connectors/`, `syncs/`, `schedules/`, `pipelines/`, `projections/`,
 * `rules/`, `workflows/`, `agents/`, and `security/{groups,roles,policies}/`
 * relative to `projectRoot`.
 */
export async function createSixb(
  options: CreateSixbOptions
): Promise<SixbHost<readonly OntologySource[]>> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd())

  const discoveredOntology = await discoverOntologySources(projectRoot)
  const allSources = [...(options.ontologies ?? []), ...discoveredOntology]

  if (allSources.length === 0) {
    throw new RuntimeError(
      "No ontology found. Create an 'ontology/' folder or pass 'ontologies' to createSixb()."
    )
  }

  const definitions = await discoverProjectDefinitions(projectRoot)

  // Explicit definitions come first so local setup can override ordering while duplicate ids are
  // still rejected by the SixbHost constructor. Every family merges — `actions` and `projections`
  // used to *replace* discovery instead, silently and undocumented.
  return new SixbHost<readonly OntologySource[]>({
    id: options.id,
    ontology: allSources,
    broker: options.broker,
    storage: options.storage,
    lakeStorage: options.lakeStorage,
    blobStorage: options.blobStorage,
    queues: options.queues,
    sandboxes: options.sandboxes,
    logger: options.logger,
    observability: options.observability,
    onError: options.onError,
    ontologyMaintenance: options.ontologyMaintenance,
    projectRoot,
    actions: [...(options.actions ?? []), ...definitions.actions],
    datasets: [...(options.datasets ?? []), ...definitions.datasets],
    connectors: [...(options.connectors ?? []), ...definitions.connectors],
    connectorConnections: options.connectorConnections,
    schedules: [...(options.schedules ?? []), ...definitions.schedules],
    syncs: [...(options.syncs ?? []), ...definitions.syncs],
    pipelines: [...(options.pipelines ?? []), ...definitions.pipelines],
    projections: [...(options.projections ?? []), ...definitions.projections],
    rules: [...(options.rules ?? []), ...definitions.rules],
    workflows: [...(options.workflows ?? []), ...definitions.workflows],
    groups: [...(options.groups ?? []), ...definitions.groups],
    roles: [...(options.roles ?? []), ...definitions.roles],
    membershipPolicies: [...(options.membershipPolicies ?? []), ...definitions.membershipPolicies],
    agents: [...(options.agents ?? []), ...definitions.agents],
    auth: options.auth,
  })
}
