import { isActionDefinition } from "../actions"
import { isAgentDefinition } from "../agents"
import { isSixbError, SixbError } from "../errors"
import type { SchemaOrRef, ValueType } from "../ontology"
import { validateSchemaOrRefValue } from "../ontology"
import type { ScheduleDefinition } from "../schedules"
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
    throw new SixbError("runtime.invalid_definition", `${subject} ${field} must not be empty.`)
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
    isAgentDefinition(value.agent) &&
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
    throw new SixbError("runtime.invalid_definition", "Invalid workflow definition.")
  }

  assertNonEmpty(value.id, "Workflow", "id")

  if (value.nodes.length === 0) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${value.id}" must contain at least one node.`
    )
  }

  const nodeIds = new Set<string>()
  const nodeKeys = new Set<string>()

  for (const node of value.nodes) {
    validateWorkflowNodeDefinition(value.id, node)

    if (nodeIds.has(node.id)) {
      throw new SixbError(
        "runtime.invalid_definition",
        `Duplicate workflow node id "${node.id}" in workflow "${value.id}".`
      )
    }
    nodeIds.add(node.id)

    if (nodeKeys.has(node.key)) {
      throw new SixbError(
        "runtime.invalid_definition",
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
        throw new SixbError(
          "runtime.invalid_definition",
          `Workflow "${workflow.id}" references unknown action "${node.action.id}". Add it to 'actions' in createSixb() or export it from 'actions/'.`
        )
      }
      if (node.type === "agent" && !options.registeredAgentIds.has(node.agentStep.agent.id)) {
        throw new SixbError(
          "runtime.invalid_definition",
          `Workflow "${workflow.id}" references unknown agent "${node.agentStep.agent.id}". Add it to 'agents' in createSixb() or export it from 'agents/'.`
        )
      }
    }
  }

  return options.workflows
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
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" contains an unsupported trigger.`
    )
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
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" contains a schedule trigger with an empty schedule id.`
    )
  }

  const schedule = registeredSchedules.get(trigger.scheduleId)
  if (!schedule) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" references unknown schedule "${trigger.scheduleId}". Add it to 'schedules' in createSixb() or export it from 'schedules/'.`
    )
  }

  if (trigger.mapper !== undefined && typeof trigger.mapper !== "function") {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" schedule "${trigger.scheduleId}" mapper must be a function.`
    )
  }

  if (trigger.mapper !== undefined && schedule.trigger.type !== "event") {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" cron schedule "${trigger.scheduleId}" does not accept a mapper.`
    )
  }

  if (trigger.mapper === undefined && inputFields.length > 0) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" schedule "${trigger.scheduleId}" requires a mapper because workflow input is not empty: ${inputFields.join(", ")}.`
    )
  }
}

function validateWorkflowNodeDefinition(workflowId: string, node: WorkflowNodeDefinition): void {
  if (!isRecord(node)) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" contains an invalid node.`
    )
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

  throw new SixbError(
    "runtime.invalid_definition",
    `Workflow "${workflowId}" contains an unsupported node type.`
  )
}

function validateAgentNodeDefinition(workflowId: string, node: WorkflowAgentNodeDefinition): void {
  if (typeof node.id !== "string" || !node.id.trim()) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" contains an agent step with an empty id.`
    )
  }
  if (typeof node.key !== "string" || !node.key.trim()) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" contains agent step "${node.id}" with an empty derived key.`
    )
  }
  if (!isAgentStepDefinition(node.agentStep)) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" contains an invalid agent node "${node.id}".`
    )
  }
  if (node.id !== node.agentStep.id) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" agent node id "${node.id}" does not match agent step definition id "${node.agentStep.id}".`
    )
  }
  if (node.mapper !== undefined && typeof node.mapper !== "function") {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" agent node "${node.id}" mapper must be a function.`
    )
  }
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
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" contains a step with an empty id.`
    )
  }

  if (typeof node.key !== "string" || !node.key.trim()) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" contains step "${node.id}" with an empty derived key.`
    )
  }

  if (!isStepDefinition(node.step)) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" contains an invalid step node "${node.id}".`
    )
  }

  if (node.id !== node.step.id) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" step node id "${node.id}" does not match step definition id "${node.step.id}".`
    )
  }

  if (node.mapper !== undefined && typeof node.mapper !== "function") {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" step node "${node.id}" mapper must be a function.`
    )
  }
}

function validateInterventionNodeDefinition(
  workflowId: string,
  node: WorkflowInterventionNodeDefinition
): void {
  if (typeof node.id !== "string" || !node.id.trim()) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" contains an intervention with an empty id.`
    )
  }

  if (typeof node.key !== "string" || !node.key.trim()) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" contains intervention "${node.id}" with an empty derived key.`
    )
  }

  if (!isInterventionDefinition(node.intervention)) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" contains an invalid intervention node "${node.id}".`
    )
  }

  if (node.id !== node.intervention.id) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" intervention node id "${node.id}" does not match intervention definition id "${node.intervention.id}".`
    )
  }

  if (node.mapper !== undefined && typeof node.mapper !== "function") {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" intervention node "${node.id}" mapper must be a function.`
    )
  }
}

function validateActionNodeDefinition(
  workflowId: string,
  node: WorkflowActionNodeDefinition
): void {
  if (typeof node.id !== "string" || !node.id.trim()) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" contains an action with an empty id.`
    )
  }

  if (typeof node.key !== "string" || !node.key.trim()) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" contains action "${node.id}" with an empty derived key.`
    )
  }

  if (!isActionDefinition(node.action)) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" contains an invalid action node "${node.id}".`
    )
  }

  if (node.id !== node.action.id) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Workflow "${workflowId}" action node id "${node.id}" does not match action definition id "${node.action.id}".`
    )
  }

  if (node.mapper !== undefined && typeof node.mapper !== "function") {
    throw new SixbError(
      "runtime.invalid_definition",
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
    throw new SixbError("runtime.invalid_input", `[Sixb] ${params.path} must be an object`)
  }

  const fieldIds = new Set(Object.keys(params.shape))
  for (const fieldId of Object.keys(params.value)) {
    if (!fieldIds.has(fieldId)) {
      throw new SixbError(
        "runtime.invalid_input",
        `[Sixb] Unknown field '${params.path}.${fieldId}'`
      )
    }
  }

  for (const [fieldId, schema] of Object.entries(params.shape)) {
    const fieldValue = params.value[fieldId]
    if (fieldValue === undefined) {
      throw new SixbError(
        "runtime.invalid_input",
        `[Sixb] Missing required field '${params.path}.${fieldId}'`
      )
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
    throw new SixbError("runtime.invalid_input", `[Sixb] ${params.path} must be an object`)
  }

  const fieldIds = new Set(Object.keys(params.response))
  for (const fieldId of Object.keys(params.value)) {
    if (!fieldIds.has(fieldId)) {
      throw new SixbError(
        "runtime.invalid_input",
        `[Sixb] Unknown field '${params.path}.${fieldId}'`
      )
    }
  }

  for (const [fieldId, field] of Object.entries(params.response)) {
    const fieldValue = params.value[fieldId]
    if (fieldValue === undefined) {
      if (!params.partial && isInterventionResponseFieldRequired(field)) {
        throw new SixbError(
          "runtime.invalid_input",
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

function toWorkflowValidationError(error: unknown): SixbError {
  if (isSixbError(error, "runtime.invalid_input")) {
    return error
  }

  if (error instanceof Error) {
    return new SixbError("runtime.invalid_input", error.message, { cause: error })
  }

  return new SixbError("runtime.invalid_input", String(error), { cause: error })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
