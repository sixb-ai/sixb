import { resolve } from "node:path"
import type { ActionDefinition } from "../actions"
import type { SixbAuthConfig } from "../auth"
import type { BlobStorage } from "../blob-storage"
import {
  discoverActions,
  discoverConnectors,
  discoverDatasets,
  discoverFunctions,
  discoverGroups,
  discoverInvitePolicies,
  discoverOntologySources,
  discoverPipelines,
  discoverProjections,
  discoverRules,
  discoverSchedules,
  discoverSyncs,
  discoverWorkflows,
} from "../bootstrap"
import type { Broker } from "../broker"
import type { ConnectorDefinition } from "../connectors/types"
import type { DatasetDefinition } from "../datasets"
import type { FunctionDefinition } from "../functions/types"
import type { LakeStorage } from "../lake-storage"
import type { PipelineDefinition } from "../pipelines/types"
import type { ProjectionDefinition } from "../projections/types"
import type { Queues } from "../queues"
import type { RuleDefinition } from "../rules"
import type { ScheduleDefinition } from "../schedules"
import type { GroupDefinition, InvitePolicyDefinition } from "../security"
import type { Storage } from "../storage"
import type { SyncDefinition } from "../syncs"
import type { WorkflowDefinition } from "../workflows"
import { RuntimeError } from "./errors"
import { Sixb } from "./sixb"
import type { OntologySource } from "./types"

export interface CreateSixbOptions {
  id?: string
  broker: Broker
  storage: Storage
  lakeStorage: LakeStorage
  blobStorage: BlobStorage
  queues: Queues
  ontologies?: readonly OntologySource[]
  actions?: readonly ActionDefinition[]
  datasets?: readonly DatasetDefinition[]
  /** Connector definitions to register in addition to auto-discovered `connectors/` exports. */
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
  auth?: SixbAuthConfig
  projectRoot?: string
}

/**
 * Create a Sixb runtime using convention-based discovery.
 *
 * Sixb auto-discovers exported definitions from `ontology/`, `actions/`, `functions/`,
 * `syncs/`, `rules/`, `workflows/`, and `connectors/` relative to `projectRoot`.
 */
export async function createSixb(
  options: CreateSixbOptions
): Promise<Sixb<readonly OntologySource[]>> {
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
    functions,
    projections,
    schedules,
    syncs,
    connectors,
    pipelines,
    datasets,
    rules,
    workflows,
    groups,
    invitePolicies,
  ] = await Promise.all([
    options.actions ?? discoverActions(projectRoot),
    options.functions ?? discoverFunctions(projectRoot),
    options.projections ?? discoverProjections(projectRoot),
    discoverSchedules(projectRoot),
    discoverSyncs(projectRoot),
    discoverConnectors(projectRoot),
    discoverPipelines(projectRoot),
    discoverDatasets(projectRoot),
    discoverRules(projectRoot),
    discoverWorkflows(projectRoot),
    discoverGroups(projectRoot),
    discoverInvitePolicies(projectRoot),
  ])

  // Explicit definitions come first so local setup can override ordering while
  // duplicate ids are still rejected by the Sixb constructor.
  const providerFunctions = functionsWithProviderDefaults(
    functions,
    options.lakeStorage.getScheduledFunctions?.() ?? []
  )

  return new Sixb<readonly OntologySource[]>({
    id: options.id,
    ontology: allSources,
    broker: options.broker,
    storage: options.storage,
    lakeStorage: options.lakeStorage,
    blobStorage: options.blobStorage,
    queues: options.queues,
    actions,
    datasets: [...(options.datasets ?? []), ...datasets],
    connectors: [...(options.connectors ?? []), ...connectors],
    functions: providerFunctions,
    schedules: [...(options.schedules ?? []), ...schedules],
    syncs: [...(options.syncs ?? []), ...syncs],
    pipelines: [...(options.pipelines ?? []), ...pipelines],
    projections,
    rules: [...(options.rules ?? []), ...rules],
    workflows: [...(options.workflows ?? []), ...workflows],
    groups: [...(options.groups ?? []), ...groups],
    invitePolicies: [...(options.invitePolicies ?? []), ...invitePolicies],
    auth: options.auth,
  })
}

function functionsWithProviderDefaults(
  userFunctions: readonly FunctionDefinition[],
  providerFunctions: readonly FunctionDefinition[]
): readonly FunctionDefinition[] {
  if (providerFunctions.length === 0) {
    return userFunctions
  }

  const userFunctionIds = new Set(userFunctions.map((fn) => fn.id))
  const acceptedProviderFunctions: FunctionDefinition[] = []

  for (const fn of providerFunctions) {
    if (userFunctionIds.has(fn.id)) {
      console.warn(
        `[Sixb] Skipping provider scheduled function '${fn.id}' because ` +
          "a user-defined function with that id is registered."
      )
      continue
    }

    acceptedProviderFunctions.push(fn)
  }

  return [...userFunctions, ...acceptedProviderFunctions]
}
