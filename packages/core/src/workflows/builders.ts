import type { ActionDefinition } from "../actions"
import { isActionDefinition } from "../actions"
import type { SchemaOrRef } from "../ontology"
import type { ScheduleDefinition } from "../schedules"
import { isScheduleDefinition } from "../schedules"
import { WorkflowDefinitionError } from "./errors"
import type {
  StepBuilder,
  StepDefinition,
  StepHandler,
  WorkflowBuilder,
  WorkflowChainDefinition,
  WorkflowNodeDefinition,
  WorkflowTriggerDefinition,
} from "./types"
import { assertNonEmpty, isStepDefinition } from "./validation"

export function defineWorkflowStep<const TId extends string>(id: TId): StepBuilder<TId> {
  assertNonEmpty(id, "Step", "id")

  return {
    input(input: Record<string, SchemaOrRef>): unknown {
      return {
        output(output: Record<string, SchemaOrRef>): unknown {
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

export function defineWorkflow<const TId extends string>(id: TId): WorkflowBuilder<TId> {
  assertNonEmpty(id, "Workflow", "id")

  return {
    input(input: Record<string, SchemaOrRef>): unknown {
      return createWorkflowDraftBuilder(id, input)
    },
  } as WorkflowBuilder<TId>
}

function createWorkflowDraftBuilder(id: string, input: Record<string, SchemaOrRef>): unknown {
  const triggers: WorkflowTriggerDefinition[] = []
  const nodes: WorkflowNodeDefinition[] = []
  let definition: WorkflowChainDefinition | null = null

  const appendNode = (
    target: unknown,
    mapper?: unknown,
    ...extraArgs: unknown[]
  ): WorkflowChainDefinition => {
    if (extraArgs.length > 0) {
      throw invalidThenOverload(id)
    }

    if (isStepDefinition(target)) {
      if (mapper !== undefined && typeof mapper !== "function") {
        throw invalidThenOverload(id)
      }

      nodes.push(createStepNode(id, nodes, target, mapper))
      definition ??= createWorkflowDefinition(id, input, triggers, nodes, appendNode)
      return definition
    }

    if (isActionDefinition(target)) {
      if (typeof mapper !== "function") {
        throw new WorkflowDefinitionError(
          `Workflow "${id}" action node "${target.id}" requires a mapper.`
        )
      }

      nodes.push(createActionNode(id, nodes, target, mapper))
      definition ??= createWorkflowDefinition(id, input, triggers, nodes, appendNode)
      return definition
    }

    throw invalidThenOverload(id)
  }

  const draft = {
    when(schedule: ScheduleDefinition): unknown {
      if (!isScheduleDefinition(schedule)) {
        throw new WorkflowDefinitionError(
          `Workflow "${id}" .when(...) only accepts schedule definitions in V1.`
        )
      }

      triggers.push({ type: "schedule", scheduleId: schedule.id })
      return draft
    },
    // biome-ignore lint/suspicious/noThenProperty: Workflows intentionally expose a chainable .then(...) DSL.
    then: appendNode,
  }

  return draft
}

function createWorkflowDefinition(
  id: string,
  input: Record<string, SchemaOrRef>,
  triggers: readonly WorkflowTriggerDefinition[],
  nodes: readonly WorkflowNodeDefinition[],
  then: (target: unknown, mapper?: unknown, ...extraArgs: unknown[]) => WorkflowChainDefinition
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
  mapper: unknown
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

function createActionNode(
  workflowId: string,
  nodes: readonly WorkflowNodeDefinition[],
  action: ActionDefinition,
  mapper: unknown
): WorkflowNodeDefinition {
  const key = deriveWorkflowNodeKey(action.id)
  assertNodeKey(workflowId, action.id, key)
  assertUniqueNode(workflowId, nodes, action.id, key)

  return {
    type: "action",
    id: action.id,
    key,
    action,
    mapper,
  }
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

function invalidThenOverload(workflowId: string): WorkflowDefinitionError {
  return new WorkflowDefinitionError(
    `Invalid workflow "${workflowId}" .then(...) overload. V1 supports then(step), then(step, mapper), and then(action, mapper).`
  )
}
