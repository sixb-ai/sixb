import { createExecutionActionsRuntime, type ExecutionActionsRuntime } from "../actions/execution"
import type { AgentDefinition } from "../agents"
import { createExecutionAgentsRuntime, type ExecutionAgentsRuntime } from "../agents/execution"
import { createExecutionBlobsRuntime, type ExecutionBlobsRuntime } from "../blob-storage/execution"
import type { BlobsRuntime } from "../blob-storage/runtime"
import {
  createExecutionConnectorsRuntime,
  type ExecutionConnectorRuntime,
  type ExecutionConnectorsRuntime,
} from "../connectors/execution"
import type { ConnectorRuntime, ConnectorsRuntime } from "../connectors/runtime"
import {
  createExecutionDatasetsRuntime,
  type ExecutionDatasetsRuntime,
} from "../datasets/execution"
import type { DatasetDefinition } from "../datasets/types"
import { createExecutionEventsRuntime, type ExecutionEventsRuntime } from "../events/execution"
import type { ExecutionContext } from "../execution"
import { createExecutionLogsRuntime, type ExecutionLogsRuntime } from "../logging/execution"
import type { LogsRuntime } from "../logging/runtime"
import { createExecutionObjectsRuntime, type ExecutionObjectsRuntime } from "../objects/execution"
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
import {
  createExecutionSchedulesRuntime,
  type ExecutionSchedulesRuntime,
} from "../schedules/execution"
import type { SchedulesRuntime } from "../schedules/runtime"
import { createExecutionSyncsRuntime, type ExecutionSyncsRuntime } from "../syncs/execution"
import type { SyncDefinition } from "../syncs/types"
import {
  createExecutionWorkflowsRuntime,
  type ExecutionWorkflowsRuntime,
} from "../workflows/execution"
import type { WorkflowDefinition } from "../workflows/types"
import type { OntologySource, SixbRuntimeContext } from "./types"

/** Domain SDK bound to one immutable execution and one registered runtime authority. */
export interface Sixb<
  TOntologySources extends readonly OntologySource[] = readonly OntologySource[],
> {
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
  readonly schedules: ExecutionSchedulesRuntime
  readonly connector: ExecutionConnectorRuntime
  readonly connectors: ExecutionConnectorsRuntime
  readonly blobs: ExecutionBlobsRuntime
}

const boundSixbInstances = new WeakSet<object>()

interface DefinitionSource<TDefinition> {
  readonly list: () => readonly TDefinition[]
  readonly getById: (id: string) => TDefinition | null
}

export interface SixbDependencies {
  readonly datasets: DefinitionSource<DatasetDefinition>
  readonly syncs: DefinitionSource<SyncDefinition>
  readonly pipelines: DefinitionSource<PipelineDefinition>
  readonly projections: ProjectionsRuntime
  readonly rules: RulesRuntime
  readonly workflows: DefinitionSource<WorkflowDefinition>
  readonly agents: DefinitionSource<AgentDefinition>
  readonly logs: LogsRuntime
  readonly schedules: SchedulesRuntime
  readonly connector: ConnectorRuntime
  readonly connectors: ConnectorsRuntime
  readonly blobs: BlobsRuntime
}

export function createBoundSixb<TOntologySources extends readonly OntologySource[]>(
  runtime: SixbRuntimeContext,
  dependencies: SixbDependencies,
  execution: ExecutionContext
): Sixb<TOntologySources> {
  const sixb: Sixb<TOntologySources> = {
    execution,
    ...createExecutionFacades<TOntologySources>(runtime, dependencies),
  }
  boundSixbInstances.add(sixb)
  return sixb
}

/** Internal nominal guard for execution boundaries that accept a narrow structural host. */
export function isBoundSixb<
  TOntologySources extends readonly OntologySource[] = readonly OntologySource[],
>(value: unknown): value is Sixb<TOntologySources> {
  return typeof value === "object" && value !== null && boundSixbInstances.has(value)
}

function createExecutionFacades<TOntologySources extends readonly OntologySource[]>(
  runtime: SixbRuntimeContext,
  dependencies: SixbDependencies
): Omit<Sixb<TOntologySources>, "execution"> {
  const connectorRuntimes = createExecutionConnectorsRuntime(
    runtime,
    dependencies.connector,
    dependencies.connectors
  )
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
    schedules: createExecutionSchedulesRuntime(dependencies.schedules),
    ...connectorRuntimes,
    blobs: createExecutionBlobsRuntime(runtime, dependencies.blobs),
  }
}
