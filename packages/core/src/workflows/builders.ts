import type { ActionDefinition } from "../actions"
import { isActionDefinition } from "../actions"
import { AGENT_REASONING_LEVELS, isAgentToolDefinition } from "../agents"
import type { SchemaOrRef } from "../ontology"
import type { ScheduleDefinition, ScheduleDefinitionForEvent } from "../schedules"
import { isScheduleDefinition } from "../schedules"
import { isGroupDefinition } from "../security"
import { WorkflowDefinitionError } from "./errors"
import type {
  AgentStepBuilder,
  AgentStepDefinition,
  DefineAgentStepConfig,
  InterventionBuilder,
  InterventionDefaultsRuntimeHandler,
  InterventionDefinition,
  InterventionFieldConfig,
  StepBuilder,
  StepDefinition,
  StepHandler,
  WorkflowBuilder,
  WorkflowChainDefinition,
  WorkflowNodeDefinition,
  WorkflowScheduleMapper,
  WorkflowTriggerDefinition,
} from "./types"
import {
  assertNonEmpty,
  isAgentStepDefinition,
  isInterventionDefinition,
  isStepDefinition,
} from "./validation"

type InterventionOptions = {
  description?: string
}

type RuntimeWorkflowInput = Record<string, SchemaOrRef>
type RuntimeWorkflowValueInput = Record<string, unknown>
type RuntimeWorkflowMapper = (...args: never[]) => unknown
type RuntimeWorkflowScheduleMapper = WorkflowScheduleMapper<unknown, RuntimeWorkflowValueInput>
type RuntimeWorkflowThenDefinition =
  | StepDefinition
  | InterventionDefinition
  | ActionDefinition
  | AgentStepDefinition
type RuntimeWorkflowThen = (
  nodeDefinition: RuntimeWorkflowThenDefinition,
  mapper?: RuntimeWorkflowMapper
) => WorkflowChainDefinition
type RuntimeWorkflowDraftBuilder = {
  when(schedule: ScheduleDefinition): RuntimeWorkflowDraftBuilder
  when(
    schedule: ScheduleDefinitionForEvent,
    mapper: RuntimeWorkflowScheduleMapper
  ): RuntimeWorkflowDraftBuilder
  readonly then: RuntimeWorkflowThen
}

/**
 * See the action-param helper for why widened booleans are rejected. Optional
 * response fields must be an explicit literal decision so inference stays honest.
 */
type StrictBoolean<T extends boolean> = boolean extends T ? never : T

type InterventionFieldResult<TSchema extends SchemaOrRef, TRequired extends boolean> = {
  readonly schema: TSchema
  readonly required: TRequired
  readonly description?: string
}

export function interventionField<const TSchema extends SchemaOrRef>(
  schema: TSchema
): InterventionFieldResult<TSchema, true>
export function interventionField<
  const TSchema extends SchemaOrRef,
  const TRequired extends boolean = true,
>(
  schema: TSchema,
  options: {
    required?: StrictBoolean<TRequired>
    description?: string
  }
): InterventionFieldResult<TSchema, TRequired>
export function interventionField(
  schema: SchemaOrRef,
  options?: { required?: boolean; description?: string }
): InterventionFieldConfig {
  return {
    schema,
    required: options?.required ?? true,
    ...(options?.description !== undefined ? { description: options.description } : {}),
  }
}

export function defineWorkflowStep<const TId extends string>(id: TId): StepBuilder<TId> {
  assertNonEmpty(id, "Step", "id")

  return {
    input(input: RuntimeWorkflowInput): unknown {
      return {
        output(output: RuntimeWorkflowInput): unknown {
          return {
            run(handler: StepHandler<Record<string, unknown>, Record<string, unknown>>): unknown {
              return {
                kind: "step",
                id,
                input,
                output,
                handler,
              }
            },
          }
        },
      }
    },
  } as unknown as StepBuilder<TId>
}

export function defineAgentStep<const TId extends string>(
  id: TId,
  config: DefineAgentStepConfig
): AgentStepBuilder<TId> {
  assertNonEmpty(id, "Agent step", "id")
  if (!isRecord(config)) {
    throw new WorkflowDefinitionError(`Agent step "${id}" config must be an object.`)
  }
  if (typeof config.instructions !== "string" || !config.instructions.trim()) {
    throw new WorkflowDefinitionError(`Agent step "${id}" instructions must not be empty.`)
  }
  if (
    config.reasoning !== undefined &&
    !(AGENT_REASONING_LEVELS as readonly string[]).includes(config.reasoning)
  ) {
    throw new WorkflowDefinitionError(
      `Agent step "${id}" reasoning must be one of: ${AGENT_REASONING_LEVELS.join(", ")}.`
    )
  }
  const { model, reasoning, instructions } = config
  const groupIds = groupIdsFromAgentStepConfig(id, config)
  const toolNames = toolNamesFromAgentStepConfig(id, config)

  return {
    input(input: RuntimeWorkflowInput): unknown {
      return {
        output(output: RuntimeWorkflowInput): unknown {
          return {
            prompt(prompt: unknown): unknown {
              if (typeof prompt !== "function") {
                throw new WorkflowDefinitionError(`Agent step "${id}" prompt must be a function.`)
              }
              return {
                kind: "agentStep",
                id,
                ...(model === undefined ? {} : { model }),
                ...(reasoning === undefined ? {} : { reasoning }),
                instructions,
                groupIds,
                toolNames,
                input,
                output,
                prompt,
              }
            },
          }
        },
      }
    },
  } as unknown as AgentStepBuilder<TId>
}

function groupIdsFromAgentStepConfig(
  stepId: string,
  config: DefineAgentStepConfig
): readonly string[] {
  if (config.groups !== undefined && !Array.isArray(config.groups)) {
    throw new WorkflowDefinitionError(
      `Agent step "${stepId}" groups must be an array of group definitions.`
    )
  }
  const groupIds = Array.from(config.groups ?? [], (group) => {
    if (!isGroupDefinition(group)) {
      throw new WorkflowDefinitionError(
        `Agent step "${stepId}" groups must contain only group definitions.`
      )
    }
    return group.id
  })
  assertUniqueAgentStepValues(stepId, "group", groupIds)
  return Object.freeze(groupIds)
}

function toolNamesFromAgentStepConfig(
  stepId: string,
  config: DefineAgentStepConfig
): readonly string[] {
  if (config.tools !== undefined && !Array.isArray(config.tools)) {
    throw new WorkflowDefinitionError(
      `Agent step "${stepId}" tools must be an array of agent tool definitions.`
    )
  }
  const toolNames = Array.from(config.tools ?? [], (tool) => {
    if (!isAgentToolDefinition(tool)) {
      throw new WorkflowDefinitionError(
        `Agent step "${stepId}" tools must contain only agent tool definitions.`
      )
    }
    return tool.name
  })
  assertUniqueAgentStepValues(stepId, "tool", toolNames)
  return Object.freeze(toolNames)
}

function assertUniqueAgentStepValues(
  stepId: string,
  kind: "group" | "tool",
  values: readonly string[]
): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) {
      throw new WorkflowDefinitionError(
        `Agent step "${stepId}" ${kind}s contains duplicate ${kind} '${value}'.`
      )
    }
    seen.add(value)
  }
}

export function defineIntervention<const TId extends string>(
  id: TId,
  options?: InterventionOptions
): InterventionBuilder<TId> {
  assertNonEmpty(id, "Intervention", "id")

  return {
    input(input: RuntimeWorkflowInput): unknown {
      return {
        response(response: Record<string, unknown>): unknown {
          return createInterventionDefinition({
            id,
            input,
            response,
            description: options?.description,
          })
        },
      }
    },
  } as unknown as InterventionBuilder<TId>
}

export function defineWorkflow<const TId extends string>(id: TId): WorkflowBuilder<TId> {
  assertNonEmpty(id, "Workflow", "id")

  return {
    input(input: RuntimeWorkflowInput): unknown {
      return createWorkflowDraftBuilder(id, input)
    },
  } as unknown as WorkflowBuilder<TId>
}

function createWorkflowDraftBuilder(
  id: string,
  input: RuntimeWorkflowInput
): RuntimeWorkflowDraftBuilder {
  const triggers: WorkflowTriggerDefinition[] = []
  const nodes: WorkflowNodeDefinition[] = []
  let definition: WorkflowChainDefinition | null = null

  const appendNode = (
    nodeDefinition: unknown,
    mapper?: unknown,
    ...extraArgs: unknown[]
  ): WorkflowChainDefinition => {
    if (extraArgs.length > 0) {
      throw new WorkflowDefinitionError(`Invalid workflow "${id}" .then(...) call.`)
    }

    if (isStepDefinition(nodeDefinition)) {
      if (mapper !== undefined && !isRuntimeWorkflowMapper(mapper)) {
        throw new WorkflowDefinitionError(`Invalid workflow "${id}" .then(...) call.`)
      }

      nodes.push(createStepNode(id, nodes, nodeDefinition, mapper))
      definition ??= createWorkflowDefinition(id, input, triggers, nodes, appendNode)
      return definition
    }

    if (isAgentStepDefinition(nodeDefinition)) {
      if (mapper !== undefined && !isRuntimeWorkflowMapper(mapper)) {
        throw new WorkflowDefinitionError(`Invalid workflow "${id}" .then(...) call.`)
      }

      nodes.push(createAgentNode(id, nodes, nodeDefinition, mapper))
      definition ??= createWorkflowDefinition(id, input, triggers, nodes, appendNode)
      return definition
    }

    if (isInterventionDefinition(nodeDefinition)) {
      if (mapper !== undefined && !isRuntimeWorkflowMapper(mapper)) {
        throw new WorkflowDefinitionError(`Invalid workflow "${id}" .then(...) call.`)
      }

      nodes.push(createInterventionNode(id, nodes, nodeDefinition, mapper))
      definition ??= createWorkflowDefinition(id, input, triggers, nodes, appendNode)
      return definition
    }

    if (isActionDefinition(nodeDefinition)) {
      if (mapper !== undefined && !isRuntimeWorkflowMapper(mapper)) {
        throw new WorkflowDefinitionError(`Invalid workflow "${id}" .then(...) call.`)
      }

      nodes.push(createActionNode(id, nodes, nodeDefinition, mapper))
      definition ??= createWorkflowDefinition(id, input, triggers, nodes, appendNode)
      return definition
    }

    throw new WorkflowDefinitionError(`Invalid workflow "${id}" .then(...) call.`)
  }

  let draft: RuntimeWorkflowDraftBuilder

  function when(schedule: ScheduleDefinition): RuntimeWorkflowDraftBuilder
  function when(
    schedule: ScheduleDefinitionForEvent,
    mapper: RuntimeWorkflowScheduleMapper
  ): RuntimeWorkflowDraftBuilder
  function when(
    schedule: unknown,
    mapper?: unknown,
    ...extraArgs: unknown[]
  ): RuntimeWorkflowDraftBuilder {
    if (extraArgs.length > 0) {
      throw new WorkflowDefinitionError(`Invalid workflow "${id}" .when(...) call.`)
    }

    if (isScheduleDefinition(schedule)) {
      if (mapper !== undefined && schedule.trigger.type !== "event") {
        throw new WorkflowDefinitionError(`Workflow "${id}" cron schedules do not accept a mapper.`)
      }
      if (mapper !== undefined && !isRuntimeWorkflowScheduleMapper(mapper)) {
        throw new WorkflowDefinitionError(`Invalid workflow "${id}" .when(...) schedule mapper.`)
      }

      triggers.push({
        type: "schedule",
        scheduleId: schedule.id,
        ...(mapper !== undefined ? { mapper } : {}),
      })
      return draft
    }

    throw new WorkflowDefinitionError(`Workflow "${id}" .when(...) only accepts schedules.`)
  }

  draft = {
    when,
    // biome-ignore lint/suspicious/noThenProperty: Workflows intentionally expose a chainable .then(...) DSL.
    then: appendNode,
  }

  return draft
}

function createWorkflowDefinition(
  id: string,
  input: RuntimeWorkflowInput,
  triggers: readonly WorkflowTriggerDefinition[],
  nodes: readonly WorkflowNodeDefinition[],
  then: (
    nodeDefinition: unknown,
    mapper?: unknown,
    ...extraArgs: unknown[]
  ) => WorkflowChainDefinition
): WorkflowChainDefinition {
  return {
    kind: "workflow",
    id,
    input,
    triggers,
    nodes,
    then,
  } as unknown as WorkflowChainDefinition
}

function createStepNode(
  workflowId: string,
  nodes: readonly WorkflowNodeDefinition[],
  step: StepDefinition,
  mapper: RuntimeWorkflowMapper | undefined
): WorkflowNodeDefinition {
  const key = deriveWorkflowNodeKey(step.id)
  assertNodeKey(workflowId, step.id, key)
  assertUniqueNode(workflowId, nodes, step.id, key)

  return {
    type: "step",
    id: step.id,
    key,
    step,
    ...(mapper !== undefined ? { mapper } : {}),
  }
}

function createAgentNode(
  workflowId: string,
  nodes: readonly WorkflowNodeDefinition[],
  agentStep: AgentStepDefinition,
  mapper: RuntimeWorkflowMapper | undefined
): WorkflowNodeDefinition {
  const key = deriveWorkflowNodeKey(agentStep.id)
  assertNodeKey(workflowId, agentStep.id, key)
  assertUniqueNode(workflowId, nodes, agentStep.id, key)

  return {
    type: "agent",
    id: agentStep.id,
    key,
    agentStep,
    ...(mapper !== undefined ? { mapper } : {}),
  }
}

function createInterventionDefinition(input: {
  readonly id: string
  readonly input: RuntimeWorkflowInput
  readonly response: Record<string, unknown>
  readonly description?: string
}): unknown {
  const base = {
    kind: "intervention" as const,
    id: input.id,
    input: input.input,
    response: input.response,
    ...(input.description !== undefined ? { description: input.description } : {}),
  }

  const defaults = (handlerOrContext: unknown) => {
    if (typeof handlerOrContext === "function") {
      return {
        ...base,
        defaults: handlerOrContext as InterventionDefaultsRuntimeHandler,
      }
    }

    // A no-defaults intervention is still usable as a definition immediately after
    // `.response(...)`. Treating the builder method as an empty default handler keeps
    // future executor code simple if it calls `definition.defaults?.(ctx) ?? {}`.
    return {}
  }

  Object.defineProperty(base, "defaults", {
    value: defaults,
    enumerable: false,
  })

  return base
}

function createActionNode(
  workflowId: string,
  nodes: readonly WorkflowNodeDefinition[],
  action: ActionDefinition,
  mapper: RuntimeWorkflowMapper | undefined
): WorkflowNodeDefinition {
  const key = deriveWorkflowNodeKey(action.id)
  assertNodeKey(workflowId, action.id, key)
  assertUniqueNode(workflowId, nodes, action.id, key)

  return {
    type: "action",
    id: action.id,
    key,
    action,
    ...(mapper !== undefined ? { mapper } : {}),
  }
}

function createInterventionNode(
  workflowId: string,
  nodes: readonly WorkflowNodeDefinition[],
  intervention: InterventionDefinition,
  mapper: RuntimeWorkflowMapper | undefined
): WorkflowNodeDefinition {
  const key = deriveWorkflowNodeKey(intervention.id)
  assertNodeKey(workflowId, intervention.id, key)
  assertUniqueNode(workflowId, nodes, intervention.id, key)

  return {
    type: "intervention",
    id: intervention.id,
    key,
    intervention,
    ...(mapper !== undefined ? { mapper } : {}),
  } as WorkflowNodeDefinition
}

function assertNodeKey(workflowId: string, nodeId: string, key: string): void {
  if (key.length === 0) {
    throw new WorkflowDefinitionError(
      `Workflow "${workflowId}" node id "${nodeId}" must contain at least one letter or number.`
    )
  }
}

function assertUniqueNode(
  workflowId: string,
  nodes: readonly WorkflowNodeDefinition[],
  nodeId: string,
  key: string
): void {
  const duplicateId = nodes.find((node) => node.id === nodeId)
  if (duplicateId) {
    throw new WorkflowDefinitionError(
      `Duplicate workflow node id "${nodeId}" in workflow "${workflowId}".`
    )
  }

  const duplicateKey = nodes.find((node) => node.key === key)
  if (duplicateKey) {
    throw new WorkflowDefinitionError(
      `Duplicate workflow node key "${key}" in workflow "${workflowId}". Node ids "${duplicateKey.id}" and "${nodeId}" derive the same key.`
    )
  }
}

function deriveWorkflowNodeKey(id: string): string {
  const segments = id
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter((segment) => segment.length > 0)

  return segments
    .map((segment, index) => {
      const normalized = uncapitalize(segment)
      return index === 0 ? normalized : capitalize(normalized)
    })
    .join("")
}

function uncapitalize(value: string): string {
  return value.length === 0 ? value : `${value[0].toLowerCase()}${value.slice(1)}`
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`
}

function isRuntimeWorkflowMapper(value: unknown): value is RuntimeWorkflowMapper {
  return typeof value === "function"
}

function isRuntimeWorkflowScheduleMapper(value: unknown): value is RuntimeWorkflowScheduleMapper {
  return typeof value === "function"
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
