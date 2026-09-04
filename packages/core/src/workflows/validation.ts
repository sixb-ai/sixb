import { isActionDefinition } from "../actions"
import { AGENT_REASONING_LEVELS, type AgentReasoningLevel, type AgentToolCatalog } from "../agents"
import type { ModelCatalog } from "../models"
import type { SchemaOrRef, ValueType } from "../ontology"
import { validateSchemaOrRefValue } from "../ontology"
import type { ScheduleDefinition } from "../schedules"
import type { SecurityDefinitionCatalog } from "../security"
import { workflowAgentStepActorId } from "./agent-step-identity"
import { WorkflowDefinitionError, WorkflowValidationError } from "./errors"
import type {
  AgentStepDefinition,
  InterventionDefinition,
  InterventionFieldConfig,
  InterventionResponseConfig,
  StepDefinition,
  WorkflowActionNodeDefinition,
  WorkflowAgentNodeDefinition,
  WorkflowDefinition,
  WorkflowInterventionNodeDefinition,
  WorkflowNodeDefinition,
  WorkflowStepNodeDefinition,
  WorkflowTriggerDefinition,
} from "./types"

export function assertNonEmpty(
  value: string,
  subject: "Step" | "Agent step" | "Workflow" | "Intervention",
  field: string
): void {
  if (!value.trim()) {
    throw new WorkflowDefinitionError(`${subject} ${field} must not be empty.`)
  }
}

export function isStepDefinition(value: unknown): value is StepDefinition {
  return (
    isRecord(value) &&
    value.kind === "step" &&
    typeof value.id === "string" &&
    isRecord(value.input) &&
    isRecord(value.output) &&
    typeof value.handler === "function"
  )
}

export function isAgentStepDefinition(value: unknown): value is AgentStepDefinition {
  return (
    isRecord(value) &&
    value.kind === "agentStep" &&
    typeof value.id === "string" &&
    (value.model === undefined || isLanguageModel(value.model)) &&
    (value.reasoning === undefined || isAgentReasoningLevel(value.reasoning)) &&
    typeof value.instructions === "string" &&
    isStringArray(value.groupIds) &&
    isStringArray(value.toolNames) &&
    isRecord(value.input) &&
    isRecord(value.output) &&
    typeof value.prompt === "function"
  )
}

export function isInterventionDefinition(value: unknown): value is InterventionDefinition {
  return (
    isRecord(value) &&
    value.kind === "intervention" &&
    typeof value.id === "string" &&
    isRecord(value.input) &&
    isRecord(value.response) &&
    (value.defaults === undefined || typeof value.defaults === "function")
  )
}

export function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  return (
    isRecord(value) &&
    value.kind === "workflow" &&
    typeof value.id === "string" &&
    isRecord(value.input) &&
    Array.isArray(value.triggers) &&
    Array.isArray(value.nodes)
  )
}

export function validateWorkflowDefinition(value: unknown): asserts value is WorkflowDefinition {
  if (!isWorkflowDefinition(value)) {
    throw new WorkflowDefinitionError("Invalid workflow definition.")
  }

  assertNonEmpty(value.id, "Workflow", "id")

  if (value.nodes.length === 0) {
    throw new WorkflowDefinitionError(`Workflow "${value.id}" must contain at least one node.`)
  }

  const nodeIds = new Set<string>()
  const nodeKeys = new Set<string>()

  for (const node of value.nodes) {
    validateWorkflowNodeDefinition(value.id, node)

    if (nodeIds.has(node.id)) {
      throw new WorkflowDefinitionError(
        `Duplicate workflow node id "${node.id}" in workflow "${value.id}".`
      )
    }
    nodeIds.add(node.id)

    if (nodeKeys.has(node.key)) {
      throw new WorkflowDefinitionError(
        `Duplicate workflow node key "${node.key}" in workflow "${value.id}".`
      )
    }
    nodeKeys.add(node.key)
  }
}

export function validateWorkflowsAtStartup(options: {
  workflows: readonly WorkflowDefinition[]
  registeredSchedules: ReadonlyMap<string, ScheduleDefinition>
  registeredActionIds: ReadonlySet<string>
  registeredAgentIds: ReadonlySet<string>
  models?: ModelCatalog
  tools: AgentToolCatalog
}): readonly WorkflowDefinition[] {
  for (const workflow of options.workflows) {
    validateWorkflowDefinition(workflow)

    for (const trigger of workflow.triggers) {
      validateWorkflowTriggerAtStartup(
        workflow.id,
        trigger,
        options.registeredSchedules,
        Object.keys(workflow.input)
      )
    }

    for (const node of workflow.nodes) {
      if (node.type === "action" && !options.registeredActionIds.has(node.action.id)) {
        throw new WorkflowDefinitionError(
          `Workflow "${workflow.id}" references unknown action "${node.action.id}". Add it to 'actions' in createSixb() or export it from 'actions/'.`
        )
      }
      if (node.type === "agent") {
        const actorId = workflowAgentStepActorId(workflow.id, node.agentStep.id)
        if (options.registeredAgentIds.has(actorId)) {
          throw new WorkflowDefinitionError(
            `Workflow "${workflow.id}" agent step "${node.id}" conflicts with registered agent "${actorId}".`
          )
        }
        validateWorkflowAgentStepRuntimeReferences(workflow.id, node.agentStep, options)
      }
    }
  }

  return options.workflows
}

/** Validate workflow task memberships once the security catalog has been composed. */
export function validateWorkflowAgentStepGroupReferences(
  workflows: readonly WorkflowDefinition[],
  security: SecurityDefinitionCatalog
): void {
  for (const workflow of workflows) {
    for (const node of workflow.nodes) {
      if (node.type !== "agent") continue
      for (const groupId of node.agentStep.groupIds) {
        if (!security.getGroupById(groupId)) {
          throw new WorkflowDefinitionError(
            `Workflow "${workflow.id}" agent step "${node.id}" references unknown group "${groupId}". Add it to 'security/groups/' or pass it to createSixb({ groups }).`
          )
        }
      }
    }
  }
}

function validateWorkflowAgentStepRuntimeReferences(
  workflowId: string,
  step: AgentStepDefinition,
  options: { readonly models?: ModelCatalog; readonly tools: AgentToolCatalog }
): void {
  if (step.model === undefined && options.models === undefined) {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" agent step "${step.id}" needs a model. Configure 'models.language' or pass 'model' to defineAgentStep().`
    )
  }
  if (step.model !== undefined && options.models !== undefined) {
    const ref = { provider: step.model.provider, modelId: step.model.modelId }
    if (options.models.language.getByRef(ref) === null) {
      throw new WorkflowDefinitionError(
        `Workflow "${workflowId}" agent step "${step.id}" uses unknown language model "${ref.provider}/${ref.modelId}". Add it to 'models.language' in createSixb().`
      )
    }
  }
  for (const toolName of step.toolNames) {
    if (options.tools.getByName(toolName) === null) {
      throw new WorkflowDefinitionError(
        `Workflow "${workflowId}" agent step "${step.id}" uses unknown project tool "${toolName}". Add it to 'tools' in createSixb().`
      )
    }
  }
}

export function validateWorkflowInput(params: {
  readonly workflow: WorkflowDefinition
  readonly value: unknown
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): Readonly<Record<string, unknown>> {
  return validateWorkflowContractRecord({
    shape: params.workflow.input,
    value: params.value,
    path: `Workflow "${params.workflow.id}" input`,
    valueTypesById: params.valueTypesById,
  })
}

export function validateWorkflowStepInput(params: {
  readonly workflowId: string
  readonly step: StepDefinition
  readonly value: unknown
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): Readonly<Record<string, unknown>> {
  return validateWorkflowContractRecord({
    shape: params.step.input,
    value: params.value,
    path: `Workflow "${params.workflowId}" step "${params.step.id}" input`,
    valueTypesById: params.valueTypesById,
  })
}

export function validateWorkflowStepOutput(params: {
  readonly workflowId: string
  readonly step: StepDefinition
  readonly value: unknown
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): Readonly<Record<string, unknown>> {
  return validateWorkflowContractRecord({
    shape: params.step.output,
    value: params.value,
    path: `Workflow "${params.workflowId}" step "${params.step.id}" output`,
    valueTypesById: params.valueTypesById,
  })
}

export function validateWorkflowInterventionInput(params: {
  readonly workflowId: string
  readonly intervention: InterventionDefinition
  readonly value: unknown
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): Readonly<Record<string, unknown>> {
  return validateWorkflowContractRecord({
    shape: params.intervention.input,
    value: params.value,
    path: `Workflow "${params.workflowId}" intervention "${params.intervention.id}" input`,
    valueTypesById: params.valueTypesById,
  })
}

export function validateWorkflowInterventionResponse(params: {
  readonly workflowId: string
  readonly intervention: InterventionDefinition
  readonly value: unknown
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): Readonly<Record<string, unknown>> {
  return validateWorkflowInterventionResponseRecord({
    response: params.intervention.response,
    value: params.value,
    path: `Workflow "${params.workflowId}" intervention "${params.intervention.id}" response`,
    partial: false,
    valueTypesById: params.valueTypesById,
  })
}

export function validateWorkflowInterventionDefaultResponse(params: {
  readonly workflowId: string
  readonly intervention: InterventionDefinition
  readonly value: unknown
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): Readonly<Record<string, unknown>> {
  return validateWorkflowInterventionResponseRecord({
    response: params.intervention.response,
    value: params.value,
    path: `Workflow "${params.workflowId}" intervention "${params.intervention.id}" defaultResponse`,
    partial: true,
    valueTypesById: params.valueTypesById,
  })
}

function validateWorkflowTriggerAtStartup(
  workflowId: string,
  trigger: WorkflowTriggerDefinition,
  registeredSchedules: ReadonlyMap<string, ScheduleDefinition>,
  inputFields: readonly string[]
): void {
  if (!isRecord(trigger) || trigger.type !== "schedule") {
    throw new WorkflowDefinitionError(`Workflow "${workflowId}" contains an unsupported trigger.`)
  }
  validateScheduleWorkflowTrigger(workflowId, trigger, registeredSchedules, inputFields)
}

function validateScheduleWorkflowTrigger(
  workflowId: string,
  trigger: Extract<WorkflowTriggerDefinition, { readonly type: "schedule" }>,
  registeredSchedules: ReadonlyMap<string, ScheduleDefinition>,
  inputFields: readonly string[]
): void {
  if (typeof trigger.scheduleId !== "string" || !trigger.scheduleId.trim()) {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" contains a schedule trigger with an empty schedule id.`
    )
  }

  const schedule = registeredSchedules.get(trigger.scheduleId)
  if (!schedule) {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" references unknown schedule "${trigger.scheduleId}". Add it to 'schedules' in createSixb() or export it from 'schedules/'.`
    )
  }

  if (trigger.mapper !== undefined && typeof trigger.mapper !== "function") {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" schedule "${trigger.scheduleId}" mapper must be a function.`
    )
  }

  if (trigger.mapper !== undefined && schedule.trigger.type !== "event") {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" cron schedule "${trigger.scheduleId}" does not accept a mapper.`
    )
  }

  if (trigger.mapper === undefined && inputFields.length > 0) {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" schedule "${trigger.scheduleId}" requires a mapper because workflow input is not empty: ${inputFields.join(", ")}.`
    )
  }
}

function validateWorkflowNodeDefinition(workflowId: string, node: WorkflowNodeDefinition): void {
  if (!isRecord(node)) {
    throw new WorkflowDefinitionError(`Workflow "${workflowId}" contains an invalid node.`)
  }

  if (node.type === "step") {
    validateStepNodeDefinition(workflowId, node)
    return
  }

  if (node.type === "agent") {
    validateAgentNodeDefinition(workflowId, node)
    return
  }

  if (node.type === "intervention") {
    validateInterventionNodeDefinition(workflowId, node)
    return
  }

  if (node.type === "action") {
    validateActionNodeDefinition(workflowId, node)
    return
  }

  throw new WorkflowDefinitionError(`Workflow "${workflowId}" contains an unsupported node type.`)
}

function validateAgentNodeDefinition(workflowId: string, node: WorkflowAgentNodeDefinition): void {
  if (typeof node.id !== "string" || !node.id.trim()) {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" contains an agent step with an empty id.`
    )
  }
  if (typeof node.key !== "string" || !node.key.trim()) {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" contains agent step "${node.id}" with an empty derived key.`
    )
  }
  if (!isAgentStepDefinition(node.agentStep)) {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" contains an invalid agent node "${node.id}".`
    )
  }
  if (node.id !== node.agentStep.id) {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" agent node id "${node.id}" does not match agent step definition id "${node.agentStep.id}".`
    )
  }
  if (!node.agentStep.instructions.trim()) {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" agent step "${node.id}" instructions must not be empty.`
    )
  }
  assertUniqueNonEmptyAgentStepValues(workflowId, node.id, "group", node.agentStep.groupIds)
  assertUniqueNonEmptyAgentStepValues(workflowId, node.id, "tool", node.agentStep.toolNames)
  if (node.mapper !== undefined && typeof node.mapper !== "function") {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" agent node "${node.id}" mapper must be a function.`
    )
  }
}

function assertUniqueNonEmptyAgentStepValues(
  workflowId: string,
  stepId: string,
  kind: "group" | "tool",
  values: readonly string[]
): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (!value.trim()) {
      throw new WorkflowDefinitionError(
        `Workflow "${workflowId}" agent step "${stepId}" has an empty ${kind} id.`
      )
    }
    if (seen.has(value)) {
      throw new WorkflowDefinitionError(
        `Workflow "${workflowId}" agent step "${stepId}" has duplicate ${kind} '${value}'.`
      )
    }
    seen.add(value)
  }
}

function isLanguageModel(value: unknown): boolean {
  return (typeof value === "object" || typeof value === "function") && value !== null
}

function isAgentReasoningLevel(value: unknown): value is AgentReasoningLevel {
  return typeof value === "string" && (AGENT_REASONING_LEVELS as readonly string[]).includes(value)
}

function isStringArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || typeof value[index] !== "string") return false
  }
  return true
}

export function validateWorkflowAgentStepInput(params: {
  readonly workflowId: string
  readonly agentStep: AgentStepDefinition
  readonly value: unknown
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): Readonly<Record<string, unknown>> {
  return validateWorkflowContractRecord({
    shape: params.agentStep.input,
    value: params.value,
    path: `Workflow "${params.workflowId}" agent step "${params.agentStep.id}" input`,
    valueTypesById: params.valueTypesById,
  })
}

export function validateWorkflowAgentStepOutput(params: {
  readonly workflowId: string
  readonly agentStep: AgentStepDefinition
  readonly value: unknown
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): Readonly<Record<string, unknown>> {
  return validateWorkflowContractRecord({
    shape: params.agentStep.output,
    value: params.value,
    path: `Workflow "${params.workflowId}" agent step "${params.agentStep.id}" output`,
    valueTypesById: params.valueTypesById,
  })
}

function validateStepNodeDefinition(workflowId: string, node: WorkflowStepNodeDefinition): void {
  if (typeof node.id !== "string" || !node.id.trim()) {
    throw new WorkflowDefinitionError(`Workflow "${workflowId}" contains a step with an empty id.`)
  }

  if (typeof node.key !== "string" || !node.key.trim()) {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" contains step "${node.id}" with an empty derived key.`
    )
  }

  if (!isStepDefinition(node.step)) {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" contains an invalid step node "${node.id}".`
    )
  }

  if (node.id !== node.step.id) {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" step node id "${node.id}" does not match step definition id "${node.step.id}".`
    )
  }

  if (node.mapper !== undefined && typeof node.mapper !== "function") {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" step node "${node.id}" mapper must be a function.`
    )
  }
}

function validateInterventionNodeDefinition(
  workflowId: string,
  node: WorkflowInterventionNodeDefinition
): void {
  if (typeof node.id !== "string" || !node.id.trim()) {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" contains an intervention with an empty id.`
    )
  }

  if (typeof node.key !== "string" || !node.key.trim()) {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" contains intervention "${node.id}" with an empty derived key.`
    )
  }

  if (!isInterventionDefinition(node.intervention)) {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" contains an invalid intervention node "${node.id}".`
    )
  }

  if (node.id !== node.intervention.id) {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" intervention node id "${node.id}" does not match intervention definition id "${node.intervention.id}".`
    )
  }

  if (node.mapper !== undefined && typeof node.mapper !== "function") {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" intervention node "${node.id}" mapper must be a function.`
    )
  }
}

function validateActionNodeDefinition(
  workflowId: string,
  node: WorkflowActionNodeDefinition
): void {
  if (typeof node.id !== "string" || !node.id.trim()) {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" contains an action with an empty id.`
    )
  }

  if (typeof node.key !== "string" || !node.key.trim()) {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" contains action "${node.id}" with an empty derived key.`
    )
  }

  if (!isActionDefinition(node.action)) {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" contains an invalid action node "${node.id}".`
    )
  }

  if (node.id !== node.action.id) {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" action node id "${node.id}" does not match action definition id "${node.action.id}".`
    )
  }

  if (node.mapper !== undefined && typeof node.mapper !== "function") {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" action node "${node.id}" mapper must be a function.`
    )
  }
}

function validateWorkflowContractRecord(params: {
  readonly shape: Readonly<Record<string, unknown>>
  readonly value: unknown
  readonly path: string
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): Readonly<Record<string, unknown>> {
  if (!isRecord(params.value)) {
    throw new WorkflowValidationError(`[Sixb] ${params.path} must be an object`)
  }

  const fieldIds = new Set(Object.keys(params.shape))
  for (const fieldId of Object.keys(params.value)) {
    if (!fieldIds.has(fieldId)) {
      throw new WorkflowValidationError(`[Sixb] Unknown field '${params.path}.${fieldId}'`)
    }
  }

  for (const [fieldId, schema] of Object.entries(params.shape)) {
    const fieldValue = params.value[fieldId]
    if (fieldValue === undefined) {
      throw new WorkflowValidationError(`[Sixb] Missing required field '${params.path}.${fieldId}'`)
    }

    try {
      validateSchemaOrRefValue(
        schema as SchemaOrRef,
        fieldValue,
        `${params.path}.${fieldId}`,
        params.valueTypesById
      )
    } catch (error) {
      throw toWorkflowValidationError(error)
    }
  }

  return params.value
}

function validateWorkflowInterventionResponseRecord(params: {
  readonly response: InterventionResponseConfig
  readonly value: unknown
  readonly path: string
  readonly partial: boolean
  readonly valueTypesById: ReadonlyMap<string, ValueType>
}): Readonly<Record<string, unknown>> {
  if (!isRecord(params.value)) {
    throw new WorkflowValidationError(`[Sixb] ${params.path} must be an object`)
  }

  const fieldIds = new Set(Object.keys(params.response))
  for (const fieldId of Object.keys(params.value)) {
    if (!fieldIds.has(fieldId)) {
      throw new WorkflowValidationError(`[Sixb] Unknown field '${params.path}.${fieldId}'`)
    }
  }

  for (const [fieldId, field] of Object.entries(params.response)) {
    const fieldValue = params.value[fieldId]
    if (fieldValue === undefined) {
      if (!params.partial && isInterventionResponseFieldRequired(field)) {
        throw new WorkflowValidationError(
          `[Sixb] Missing required field '${params.path}.${fieldId}'`
        )
      }
      continue
    }

    try {
      validateSchemaOrRefValue(
        interventionResponseFieldSchema(field),
        fieldValue,
        `${params.path}.${fieldId}`,
        params.valueTypesById
      )
    } catch (error) {
      throw toWorkflowValidationError(error)
    }
  }

  return params.value
}

export function isInterventionFieldConfig(value: unknown): value is InterventionFieldConfig {
  return isRecord(value) && "schema" in value
}

export function interventionResponseFieldSchema(field: unknown): SchemaOrRef {
  return (isInterventionFieldConfig(field) ? field.schema : field) as SchemaOrRef
}

export function isInterventionResponseFieldRequired(field: unknown): boolean {
  return !isInterventionFieldConfig(field) || field.required !== false
}

function toWorkflowValidationError(error: unknown): WorkflowValidationError {
  if (error instanceof WorkflowValidationError) {
    return error
  }

  if (error instanceof Error) {
    return new WorkflowValidationError(error.message, { cause: error })
  }

  return new WorkflowValidationError(String(error), { cause: error })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
