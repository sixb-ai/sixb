import { ActionRegistry } from "../actions"
import type { ActionDefinition } from "../actions/types"
import type { AgentDefinitionsInput, AgentToolDefinition } from "../agents"
import { assertNoAgentDefinitions } from "../agents/retired-config"
import { createAgentSkillCatalog } from "../agents/skills"
import { createAgentToolCatalog } from "../agents/tool-catalog"
import type { ConnectorDefinition } from "../connectors"
import { isDatasetPick } from "../datasets/builders"
import { columnsByName } from "../datasets/column-index"
import type { DatasetDefinition } from "../datasets/types"
import { assertDatasetDefinition } from "../datasets/validation"
import { createModelCatalog, type ModelCatalogInput } from "../models"
import { sameEmbeddingModel } from "../models/embedding-model"
import { OntologyRegistry } from "../ontology"
import { createOntologyDocsCatalog } from "../ontology/docs"
import type { PipelineDefinition } from "../pipelines/types"
import { ProjectionRegistry } from "../projections"
import type { ProjectionDefinition } from "../projections/types"
import { type RuleDefinition, validateRulesAtStartup } from "../rules"
import { type ScheduleDefinition, validateSchedulesAtStartup } from "../schedules"
import {
  type GroupDefinition,
  type MarkingDefinition,
  type MembershipPolicyDefinition,
  type RoleDefinition,
  SecurityRegistry,
} from "../security"
import { validateMarkingsAtStartup } from "../security/markings"
import { type ShareDefinition, validateSharesAtStartup } from "../shares"
import type { SyncDefinition } from "../syncs"
import {
  validateKeyedDatasetWriterTopology,
  validateMergeSyncProjectionSafety,
} from "../syncs/validation"
import type { WorkflowDefinition } from "../workflows"
import { validateWorkflowAgentStepGroupReferences, validateWorkflowsAtStartup } from "../workflows"
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
  readonly tools?: readonly AgentToolDefinition[]
  readonly agent?: AgentDefinitionsInput
  readonly models?: ModelCatalogInput
  readonly shares?: readonly ShareDefinition[]
  readonly markings?: readonly MarkingDefinition[]
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
  assertNoAgentDefinitions(options)
  const ontology = new OntologyRegistry({ sources: options.ontology })
  const actionRegistry = new ActionRegistry({ actions: options.actions ?? [], ontology })
  const registeredActionIds = new Set(actionRegistry.list().map((action) => action.id))
  const sharesById = validateSharesAtStartup({
    shares: options.shares ?? [],
    ontology,
    actions: actionRegistry,
  })

  const models = options.models === undefined ? undefined : createModelCatalog(options.models)
  for (const type of ontology.listObjectTypes()) {
    for (const [name, profile] of Object.entries(type.search?.vectors ?? {})) {
      const registered = models?.embedding.getByRef({
        provider: profile.model.providerId,
        modelId: profile.model.modelId,
      })
      if (!registered || !sameEmbeddingModel(registered.model, profile.model)) {
        throw new Error(
          "[Sixb] Vector profile " +
            type.id +
            "." +
            name +
            " requires its model in models.embedding with matching identity and dimensions."
        )
      }
    }
  }
  const tools = createAgentToolCatalog(options.tools)
  const skills = createAgentSkillCatalog(options.agent?.skills)
  const ontologyDocs = createOntologyDocsCatalog({
    objectTypes: ontology.listObjectTypes(),
    ...(options.agent?.ontologyDocs === undefined ? {} : { docs: options.agent.ontologyDocs }),
  })
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

    const target = datasetsById.get(sync.target.dataset.id)
    if (!target) {
      throw new RuntimeError(
        `Sync '${sync.id}' targets unknown dataset '${sync.target.dataset.id}'. Add it to 'datasets' in createSixb() or export it from 'datasets/'.`
      )
    }
    assertRegisteredColumns(`Sync '${sync.id}' target '${target.id}'`, sync.target.dataset, target)

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
    ...(models === undefined ? {} : { models }),
    tools,
    skills,
  })
  const workflowsById = indexUniqueDefinitions("workflow", workflows)

  const security = new SecurityRegistry({
    markings: options.markings ?? [],
    groups: options.groups ?? [],
    roles: options.roles ?? [],
    membershipPolicies: options.membershipPolicies ?? [],
    objectTypeIds: new Set(ontology.getObjectTypesById().keys()),
    datasetIds: new Set(datasetsById.keys()),
    actionIds: registeredActionIds,
    workflowIds: new Set(workflowsById.keys()),
    syncIds: new Set(syncsById.keys()),
    pipelineIds: new Set(pipelinesById.keys()),
    agentAvailable: models?.language !== undefined,
    connectorIds: new Set(connectorsById.keys()),
    shareIds: new Set(sharesById.keys()),
    getSubTypes: (objectTypeId) => ontology.listSubTypes(objectTypeId),
  })
  validateWorkflowAgentStepGroupReferences(workflows, security)

  const projectionRegistry = new ProjectionRegistry({
    projections: options.projections ?? [],
    ontology,
    datasetsById,
  })
  validateMergeSyncProjectionSafety({
    syncs,
    telemetryProjections: projectionRegistry.listTelemetry(),
  })
  validateMarkingsAtStartup({
    markingIds: new Set(security.listMarkings().map((marking) => marking.id)),
    ontology,
    datasetsById,
    pipelines,
    projections: projectionRegistry,
  })

  return Object.freeze({
    ontology,
    actions: actionRegistry,
    tools,
    agent: Object.freeze({
      skills,
      ...(options.agent?.instructions === undefined
        ? {}
        : { instructions: options.agent.instructions }),
      ontologyDocs,
    }),
    connectors: createDefinitionCatalog(connectorsById),
    datasets: createDefinitionCatalog(datasetsById),
    ...(models === undefined ? {} : { models }),
    pipelines: createDefinitionCatalog(pipelinesById),
    projections: projectionRegistry,
    rules: createDefinitionCatalog(rulesById),
    schedules: createDefinitionCatalog(schedulesById),
    security,
    shares: createDefinitionCatalog(sharesById),
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
      const registered = datasetsById.get(dataset.id)
      if (!registered) {
        throw new RuntimeError(
          `Pipeline '${pipeline.id}' step '${step.id}' input '${inputName}' references unknown dataset '${dataset.id}'. Add it to 'datasets' in createSixb() or export it from 'datasets/'.`
        )
      }
      assertRegisteredColumns(
        `Pipeline '${pipeline.id}' step '${step.id}' input '${inputName}'`,
        dataset,
        registered,
        { pick: "allowed" }
      )
    }

    const output = datasetsById.get(step.output.id)
    if (!output) {
      throw new RuntimeError(
        `Pipeline '${pipeline.id}' step '${step.id}' outputs unknown dataset '${step.output.id}'. Add it to 'datasets' in createSixb() or export it from 'datasets/'.`
      )
    }
    assertRegisteredColumns(
      `Pipeline '${pipeline.id}' step '${step.id}' output '${output.id}'`,
      step.output,
      output
    )
  }
}

/**
 * A definition with a registered id stands for the whole dataset unless `pick()` made it, and only
 * a step input may be a pick. Comparing columns catches a stale copy of a definition, which would
 * read or write other columns than the registered ones.
 */
function assertRegisteredColumns(
  subject: string,
  dataset: DatasetDefinition,
  registered: DatasetDefinition,
  options: { readonly pick?: "allowed" } = {}
): void {
  // The registered definition itself, as almost every step and sync uses.
  if (dataset === registered) return
  const pick = isDatasetPick(dataset)
  if (pick && options.pick !== "allowed") {
    throw new RuntimeError(`${subject} must be the whole dataset, not a pick.`)
  }
  const registeredColumns = columnsByName(registered)
  for (const column of dataset.schema.columns) {
    const declared = registeredColumns.get(column.name)
    if (!declared) {
      throw new RuntimeError(
        `${subject} has column '${column.name}', which dataset '${registered.id}' does not declare. Use the registered definition.`
      )
    }
    if (declared.type !== column.type) {
      throw new RuntimeError(
        `${subject} has column '${column.name}' as '${column.type}', but dataset '${registered.id}' declares it as '${declared.type}'. Use the registered definition.`
      )
    }
  }
  if (!pick && dataset.schema.columns.length !== registeredColumns.size) {
    const hint = options.pick === "allowed" ? ", or .pick(...) to read some of its columns" : ""
    throw new RuntimeError(
      `${subject} lacks columns of dataset '${registered.id}'. Use the registered definition${hint}.`
    )
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
