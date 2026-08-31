import { ActionRegistry } from "../actions"
import type { ActionDefinition } from "../actions/types"
import type { AgentDefinition } from "../agents"
import { validateAgentGroupReferences, validateAgentToolsAtStartup } from "../agents"
import type { ConnectorDefinition } from "../connectors"
import type { DatasetDefinition } from "../datasets/types"
import { assertDatasetDefinition } from "../datasets/validation"
import { createModelCatalog, type ModelCatalog, type ModelCatalogInput } from "../models"
import { OntologyRegistry } from "../ontology"
import type { PipelineDefinition } from "../pipelines/types"
import { ProjectionRegistry } from "../projections"
import type { ProjectionDefinition } from "../projections/types"
import { type RuleDefinition, validateRulesAtStartup } from "../rules"
import { type ScheduleDefinition, validateSchedulesAtStartup } from "../schedules"
import {
  type GroupDefinition,
  type MembershipPolicyDefinition,
  type RoleDefinition,
  SecurityRegistry,
} from "../security"
import type { SyncDefinition } from "../syncs"
import {
  validateKeyedDatasetWriterTopology,
  validateMergeSyncProjectionSafety,
} from "../syncs/validation"
import type { WorkflowDefinition } from "../workflows"
import { validateWorkflowsAtStartup } from "../workflows"
import { createDefinitionCatalog, type SixbDefinitions } from "./definitions"
import { RuntimeError } from "./errors"
import type { OntologySource } from "./types"

interface DefinitionOptions {
  readonly ontology: readonly OntologySource[]
  readonly actions?: readonly ActionDefinition[]
  readonly connectors?: readonly ConnectorDefinition[]
  readonly datasets?: readonly DatasetDefinition[]
  readonly schedules?: readonly ScheduleDefinition[]
  readonly syncs?: readonly SyncDefinition[]
  readonly pipelines?: readonly PipelineDefinition[]
  readonly projections?: readonly ProjectionDefinition[]
  readonly rules?: readonly RuleDefinition[]
  readonly workflows?: readonly WorkflowDefinition[]
  readonly agents?: readonly AgentDefinition[]
  readonly models?: ModelCatalogInput
  readonly groups?: readonly GroupDefinition[]
  readonly roles?: readonly RoleDefinition[]
  readonly membershipPolicies?: readonly MembershipPolicyDefinition[]
}

interface ResolvedDefinitions extends SixbDefinitions {
  readonly ontology: OntologyRegistry
  readonly actions: ActionRegistry
  readonly projections: ProjectionRegistry
  readonly security: SecurityRegistry
}

/** Resolve and cross-validate every registered definition before runtime services are composed. */
export function resolveDefinitions(options: DefinitionOptions): ResolvedDefinitions {
  const ontology = new OntologyRegistry({ sources: options.ontology })
  const actionRegistry = new ActionRegistry({ actions: options.actions ?? [], ontology })
  const registeredActionIds = new Set(actionRegistry.list().map((action) => action.id))

  const agents = options.agents ?? []
  validateAgentToolsAtStartup(agents)
  const models = options.models === undefined ? undefined : createModelCatalog(options.models)
  validateAgentModelReferences(agents, models)
  const agentsById = indexUniqueDefinitions("agent", agents)
  const connectorsById = indexUniqueDefinitions("connector", options.connectors ?? [])

  // Datasets resolve first because syncs, pipelines, projections, and security depend on them.
  const datasetsById = new Map<string, DatasetDefinition>()
  for (const dataset of options.datasets ?? []) {
    assertDatasetDefinition(dataset, (message) => new RuntimeError(message))
    assertUniqueDefinitionId("dataset", dataset.id, datasetsById)
    datasetsById.set(dataset.id, dataset)
  }

  const schedulesById = indexUniqueDefinitions("schedule", options.schedules ?? [])

  const syncsById = new Map<string, SyncDefinition>()
  for (const sync of options.syncs ?? []) {
    assertUniqueDefinitionId("sync", sync.id, syncsById)

    if (!datasetsById.has(sync.target.dataset.id)) {
      throw new RuntimeError(
        `Sync '${sync.id}' targets unknown dataset '${sync.target.dataset.id}'. Add it to 'datasets' in createSixb() or export it from 'datasets/'.`
      )
    }

    syncsById.set(sync.id, sync)
  }

  const pipelinesById = new Map<string, PipelineDefinition>()
  for (const pipeline of options.pipelines ?? []) {
    assertUniqueDefinitionId("pipeline", pipeline.id, pipelinesById)
    validatePipelineDatasets(pipeline, datasetsById)
    pipelinesById.set(pipeline.id, pipeline)
  }

  const schedules = [...schedulesById.values()]
  const syncs = [...syncsById.values()]
  const pipelines = [...pipelinesById.values()]

  validateKeyedDatasetWriterTopology({ datasetsById, syncs, pipelines })

  // Rules resolve against the complete ontology so inherited properties and links are available.
  const rules = options.rules ?? []
  validateRulesAtStartup(rules, ontology)
  const rulesById = indexUniqueDefinitions("rule", rules)

  validateSchedulesAtStartup(schedules, ontology, {
    registeredRuleIds: new Set(rulesById.keys()),
    registeredActionIds,
    registeredDatasetIds: new Set(datasetsById.keys()),
    registeredSyncIds: new Set(syncsById.keys()),
    registeredPipelineIds: new Set(pipelinesById.keys()),
  })
  for (const sync of syncs) {
    validateScheduleReferences("Sync", sync.id, sync.triggers, schedulesById)
  }
  for (const pipeline of pipelines) {
    validateScheduleReferences("Pipeline", pipeline.id, pipeline.triggers, schedulesById)
  }

  const workflows = validateWorkflowsAtStartup({
    workflows: options.workflows ?? [],
    registeredSchedules: schedulesById,
    registeredActionIds,
    registeredAgentIds: new Set(agentsById.keys()),
  })
  const workflowsById = indexUniqueDefinitions("workflow", workflows)

  const security = new SecurityRegistry({
    groups: options.groups ?? [],
    roles: options.roles ?? [],
    membershipPolicies: options.membershipPolicies ?? [],
    objectTypeIds: new Set(ontology.getObjectTypesById().keys()),
    datasetIds: new Set(datasetsById.keys()),
    actionIds: registeredActionIds,
    workflowIds: new Set(workflowsById.keys()),
    syncIds: new Set(syncsById.keys()),
    pipelineIds: new Set(pipelinesById.keys()),
    agentIds: new Set(agentsById.keys()),
    connectorIds: new Set(connectorsById.keys()),
    getSubTypes: (objectTypeId) => ontology.listSubTypes(objectTypeId),
  })
  validateAgentGroupReferences(agents, security)

  const projectionRegistry = new ProjectionRegistry({
    projections: options.projections ?? [],
    ontology,
    datasetsById,
  })
  validateMergeSyncProjectionSafety({
    syncs,
    telemetryProjections: projectionRegistry.listTelemetry(),
  })

  return Object.freeze({
    ontology,
    actions: actionRegistry,
    agents: createDefinitionCatalog(agentsById),
    connectors: createDefinitionCatalog(connectorsById),
    datasets: createDefinitionCatalog(datasetsById),
    ...(models === undefined ? {} : { models }),
    pipelines: createDefinitionCatalog(pipelinesById),
    projections: projectionRegistry,
    rules: createDefinitionCatalog(rulesById),
    schedules: createDefinitionCatalog(schedulesById),
    security,
    syncs: createDefinitionCatalog(syncsById),
    workflows: createDefinitionCatalog(workflowsById),
  })
}

function indexUniqueDefinitions<TDefinition extends { readonly id: string }>(
  kind: "schedule" | "workflow" | "agent" | "connector" | "rule",
  definitions: readonly TDefinition[]
): ReadonlyMap<string, TDefinition> {
  const definitionsById = new Map<string, TDefinition>()
  for (const definition of definitions) {
    assertUniqueDefinitionId(kind, definition.id, definitionsById)
    definitionsById.set(definition.id, definition)
  }
  return definitionsById
}

function assertUniqueDefinitionId(
  kind: "dataset" | "schedule" | "sync" | "pipeline" | "workflow" | "agent" | "connector" | "rule",
  id: string,
  definitionsById: ReadonlyMap<string, unknown>
): void {
  if (definitionsById.has(id)) {
    throw new RuntimeError(`Duplicate ${kind} id: ${id}`)
  }
}

function validatePipelineDatasets(
  pipeline: PipelineDefinition,
  datasetsById: ReadonlyMap<string, DatasetDefinition>
): void {
  if (pipeline.graph.nodes.length === 0) {
    throw new RuntimeError(`Pipeline '${pipeline.id}' must contain at least one step.`)
  }

  const stepIds = new Set<string>()
  for (const node of pipeline.graph.nodes) {
    const { step } = node
    if (stepIds.has(step.id)) {
      throw new RuntimeError(`Pipeline '${pipeline.id}' contains duplicate step id '${step.id}'.`)
    }
    stepIds.add(step.id)

    for (const [inputName, dataset] of Object.entries(step.inputs)) {
      if (!datasetsById.has(dataset.id)) {
        throw new RuntimeError(
          `Pipeline '${pipeline.id}' step '${step.id}' input '${inputName}' references unknown dataset '${dataset.id}'. Add it to 'datasets' in createSixb() or export it from 'datasets/'.`
        )
      }
    }

    if (!datasetsById.has(step.output.id)) {
      throw new RuntimeError(
        `Pipeline '${pipeline.id}' step '${step.id}' outputs unknown dataset '${step.output.id}'. Add it to 'datasets' in createSixb() or export it from 'datasets/'.`
      )
    }
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

/**
 * Keep every agent on a model the project actually allows.
 *
 * Only enforced once a project configures `models`; without a catalog an agent's model is its own
 * declaration, which is the pre-catalog behavior.
 */
function validateAgentModelReferences(
  agents: readonly AgentDefinition[],
  models: ModelCatalog | undefined
): void {
  if (models === undefined) {
    return
  }
  for (const agent of agents) {
    const ref = { provider: agent.model.provider, modelId: agent.model.modelId }
    if (models.language.getByRef(ref) === null) {
      throw new RuntimeError(
        `[Sixb] Agent '${agent.id}' uses unknown language model '${ref.provider}/${ref.modelId}'. Add it to 'models.language' in createSixb().`
      )
    }
  }
}
