import { createExecutionActionsRuntime, type ExecutionActionsRuntime } from "../actions/execution"
import type { AgentDefinition } from "../agents"
import { createExecutionAgentsRuntime, type ExecutionAgentsRuntime } from "../agents/execution"
import type { AuthorizationContext } from "../authorization"
import {
  createExecutionDatasetsRuntime,
  type ExecutionDatasetsRuntime,
} from "../datasets/execution"
import type { DatasetDefinition } from "../datasets/types"
import { createExecutionEventsRuntime, type ExecutionEventsRuntime } from "../events/execution"
import type { ExecutionContext } from "../execution"
import { createExecutionLogsRuntime, type ExecutionLogsRuntime } from "../logging/execution"
import type { LogsRuntime } from "../logging/runtime"
import {
  createExecutionObjectsRuntime,
  type ExecutionObjectByIdHandle,
  type ExecutionObjectSet,
  type ExecutionObjectsRuntime,
} from "../objects/execution"
import type { ValueType } from "../ontology"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import {
  createExecutionPipelinesRuntime,
  type ExecutionPipelinesRuntime,
} from "../pipelines/execution"
import type { PipelineDefinition } from "../pipelines/types"
import {
  createExecutionProjectionsRuntime,
  type ExecutionProjectionsRuntime,
} from "../projections/execution"
import type { ProjectionsRuntime } from "../projections/runtime"
import { createExecutionRulesRuntime, type ExecutionRulesRuntime } from "../rules/execution"
import type { RulesRuntime } from "../rules/runtime"
import { createExecutionSyncsRuntime, type ExecutionSyncsRuntime } from "../syncs/execution"
import type { SyncDefinition } from "../syncs/types"
import {
  createExecutionWorkflowsRuntime,
  type ExecutionWorkflowsRuntime,
} from "../workflows/execution"
import type { WorkflowDefinition } from "../workflows/types"
import type { OntologySource, SixbRuntimeContext } from "./types"

/** Transitional aliases kept until slice 2C promotes the execution SDK to `Sixb`. */
export type ScopedObjectByIdHandle<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
> = ExecutionObjectByIdHandle<TObjectType, TValueTypes>

export type ScopedObjectSet<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
  TRegisteredObjectTypes extends ObjectTypeWithPropertyTokens = TObjectType,
> = ExecutionObjectSet<TObjectType, TValueTypes, TRegisteredObjectTypes>

export type ScopedObjectsRuntime<TOntologySources extends readonly OntologySource[]> =
  ExecutionObjectsRuntime<TOntologySources>

export type ScopedActionsRuntime = ExecutionActionsRuntime
export type ScopedDatasetsRuntime = ExecutionDatasetsRuntime
export type ScopedWorkflowsRuntime = ExecutionWorkflowsRuntime
export type ScopedSyncsRuntime = ExecutionSyncsRuntime
export type ScopedPipelinesRuntime = ExecutionPipelinesRuntime
export type ScopedProjectionsRuntime = ExecutionProjectionsRuntime
export type ScopedRulesRuntime = ExecutionRulesRuntime
export type ScopedAgentsRuntime = ExecutionAgentsRuntime
export type ScopedEventsRuntime = ExecutionEventsRuntime
export type ScopedLogsRuntime = ExecutionLogsRuntime

export interface ScopedSixb<TOntologySources extends readonly OntologySource[]> {
  readonly authorization: AuthorizationContext
  readonly objects: ScopedObjectsRuntime<TOntologySources>
  readonly actions: ScopedActionsRuntime
  readonly datasets: ScopedDatasetsRuntime
  readonly workflows: ScopedWorkflowsRuntime
  readonly syncs: ScopedSyncsRuntime
  readonly pipelines: ScopedPipelinesRuntime
  readonly projections: ScopedProjectionsRuntime
  readonly rules: ScopedRulesRuntime
  readonly agents: ScopedAgentsRuntime
  readonly events: ScopedEventsRuntime
  readonly logs: ScopedLogsRuntime
}

/** Transitional name for the execution-bound SDK; slice 2C promotes this surface to `Sixb`. */
export interface ExecutionSixb<TOntologySources extends readonly OntologySource[]> {
  readonly execution: ExecutionContext
  readonly objects: ExecutionObjectsRuntime<TOntologySources>
  readonly actions: ExecutionActionsRuntime
  readonly datasets: ExecutionDatasetsRuntime
  readonly workflows: ExecutionWorkflowsRuntime
  readonly syncs: ExecutionSyncsRuntime
  readonly pipelines: ExecutionPipelinesRuntime
  readonly projections: ExecutionProjectionsRuntime
  readonly rules: ExecutionRulesRuntime
  readonly agents: ExecutionAgentsRuntime
  readonly events: ExecutionEventsRuntime
  readonly logs: ExecutionLogsRuntime
}

interface DefinitionSource<TDefinition> {
  readonly list: () => readonly TDefinition[]
  readonly getById: (id: string) => TDefinition | null
}

export interface ExecutionSixbDependencies {
  readonly datasets: DefinitionSource<DatasetDefinition>
  readonly syncs: DefinitionSource<SyncDefinition>
  readonly pipelines: DefinitionSource<PipelineDefinition>
  readonly projections: ProjectionsRuntime
  readonly rules: RulesRuntime
  readonly workflows: DefinitionSource<WorkflowDefinition>
  readonly agents: DefinitionSource<AgentDefinition>
  readonly logs: LogsRuntime
}

export function createScopedSixb<TOntologySources extends readonly OntologySource[]>(
  runtime: SixbRuntimeContext & { readonly authorization: AuthorizationContext },
  dependencies: ExecutionSixbDependencies
): ScopedSixb<TOntologySources> {
  return {
    authorization: runtime.authorization,
    ...createExecutionFacades<TOntologySources>(runtime, dependencies),
  }
}

export function createExecutionSixb<TOntologySources extends readonly OntologySource[]>(
  runtime: SixbRuntimeContext,
  dependencies: ExecutionSixbDependencies,
  execution: ExecutionContext
): ExecutionSixb<TOntologySources> {
  return {
    execution,
    ...createExecutionFacades<TOntologySources>(runtime, dependencies),
  }
}

function createExecutionFacades<TOntologySources extends readonly OntologySource[]>(
  runtime: SixbRuntimeContext,
  dependencies: ExecutionSixbDependencies
): Omit<ExecutionSixb<TOntologySources>, "execution"> {
  return {
    objects: createExecutionObjectsRuntime<TOntologySources>(runtime),
    actions: createExecutionActionsRuntime(runtime),
    datasets: createExecutionDatasetsRuntime(runtime, dependencies.datasets),
    workflows: createExecutionWorkflowsRuntime(runtime, dependencies.workflows),
    syncs: createExecutionSyncsRuntime(runtime, dependencies.syncs),
    pipelines: createExecutionPipelinesRuntime(runtime, dependencies.pipelines),
    projections: createExecutionProjectionsRuntime(runtime, dependencies.projections),
    rules: createExecutionRulesRuntime(runtime, dependencies.rules),
    agents: createExecutionAgentsRuntime(runtime, dependencies.agents),
    events: createExecutionEventsRuntime(runtime),
    logs: createExecutionLogsRuntime(runtime, dependencies.logs),
  }
}
