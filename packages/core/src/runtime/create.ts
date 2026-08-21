import { resolve } from "node:path"
import type { ActionDefinition } from "../actions"
import type { AgentDefinition } from "../agents"
import type { SixbAuthConfig } from "../auth"
import type { BlobStorage } from "../blob-storage"
import {
  discoverActions,
  discoverAgents,
  discoverConnectors,
  discoverDatasets,
  discoverGroups,
  discoverMembershipPolicies,
  discoverOntologySources,
  discoverPipelines,
  discoverProjections,
  discoverRoles,
  discoverRules,
  discoverSchedules,
  discoverShares,
  discoverSyncs,
  discoverWorkflows,
} from "../bootstrap"
import type { Broker } from "../broker"
import type { ConnectorDefinition } from "../connectors/types"
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
import type { ShareTypeDefinition } from "../shares"
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
  schedules?: readonly ScheduleDefinition[]
  syncs?: readonly SyncDefinition[]
  pipelines?: readonly PipelineDefinition[]
  projections?: readonly ProjectionDefinition[]
  rules?: readonly RuleDefinition[]
  workflows?: readonly WorkflowDefinition[]
  groups?: readonly GroupDefinition[]
  roles?: readonly RoleDefinition[]
  membershipPolicies?: readonly MembershipPolicyDefinition[]
  /** Share types to register in addition to auto-discovered `shares/` exports. */
  shares?: readonly ShareTypeDefinition[]
  auth?: SixbAuthConfig
  projectRoot?: string
}

/**
 * Create a SixbHost using convention-based discovery.
 *
 * The host auto-discovers exported definitions from `ontology/`, `actions/`, `datasets/`,
 * `connectors/`, `syncs/`, `schedules/`, `pipelines/`, `projections/`,
 * `rules/`, `workflows/`, `agents/`, `shares/`, and `security/{groups,roles,policies}/`
 * relative to `projectRoot`.
 */
export async function createSixb(
  options: CreateSixbOptions
): Promise<SixbHost<readonly OntologySource[]>> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd())

  const discovered = await discoverOntologySources(projectRoot)
  const allSources = [...(options.ontologies ?? []), ...discovered]

  if (allSources.length === 0) {
    throw new RuntimeError(
      "No ontology found. Create an 'ontology/' folder or pass 'ontologies' to createSixb()."
    )
  }

  const [
    actions,
    projections,
    schedules,
    syncs,
    connectors,
    pipelines,
    datasets,
    rules,
    workflows,
    groups,
    roles,
    membershipPolicies,
    agents,
    shares,
  ] = await Promise.all([
    discoverActions(projectRoot),
    discoverProjections(projectRoot),
    discoverSchedules(projectRoot),
    discoverSyncs(projectRoot),
    discoverConnectors(projectRoot),
    discoverPipelines(projectRoot),
    discoverDatasets(projectRoot),
    discoverRules(projectRoot),
    discoverWorkflows(projectRoot),
    discoverGroups(projectRoot),
    discoverRoles(projectRoot),
    discoverMembershipPolicies(projectRoot),
    discoverAgents(projectRoot),
    discoverShares(projectRoot),
  ])

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
    actions: [...(options.actions ?? []), ...actions],
    datasets: [...(options.datasets ?? []), ...datasets],
    connectors: [...(options.connectors ?? []), ...connectors],
    schedules: [...(options.schedules ?? []), ...schedules],
    syncs: [...(options.syncs ?? []), ...syncs],
    pipelines: [...(options.pipelines ?? []), ...pipelines],
    projections: [...(options.projections ?? []), ...projections],
    rules: [...(options.rules ?? []), ...rules],
    workflows: [...(options.workflows ?? []), ...workflows],
    groups: [...(options.groups ?? []), ...groups],
    roles: [...(options.roles ?? []), ...roles],
    membershipPolicies: [...(options.membershipPolicies ?? []), ...membershipPolicies],
    agents: [...(options.agents ?? []), ...agents],
    shares: [...(options.shares ?? []), ...shares],
    auth: options.auth,
  })
}
