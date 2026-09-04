import { type ActionsRuntime, createActionsRuntime } from "../actions/execution"
import { type AgentsRuntime, createAgentsRuntime } from "../agents/execution"
import { type BlobsRuntime, createBlobsRuntime } from "../blob-storage/execution"
import type { BlobStorage } from "../blob-storage/types"
import { registerConnectorConnectionsRuntime } from "../connectors/connections/capability"
import type { ConnectorConnectionProcess } from "../connectors/connections/contracts"
import { createConnectorConnectionsRuntime } from "../connectors/connections/execution"
import { type ConnectorRuntime, createConnectorRuntime } from "../connectors/execution"
import type { ConnectorService } from "../connectors/service"
import { createDatasetsRuntime, type DatasetsRuntime } from "../datasets/execution"
import { createEventsRuntime, type EventsRuntime } from "../events/execution"
import type { ExecutionContext } from "../execution"
import { createLogsRuntime, type LogsRuntime } from "../logging/execution"
import type { LoggingService } from "../logging/service"
import { createObjectsRuntime, type ObjectsRuntime } from "../objects/execution"
import { createPipelinesRuntime, type PipelinesRuntime } from "../pipelines/execution"
import { createProjectionsRuntime, type ProjectionsRuntime } from "../projections/execution"
import { createRulesRuntime, type RulesRuntime } from "../rules/execution"
import { createSchedulesRuntime, type SchedulesRuntime } from "../schedules/execution"
import { createSyncsRuntime, type SyncsRuntime } from "../syncs/execution"
import { createWorkflowsRuntime, type WorkflowsRuntime } from "../workflows/execution"
import type { SixbDefinitions } from "./definitions"
import { shareOntologyMutationRuntime } from "./ontology-mutations"
import type { OntologySource, SixbRuntimeContext } from "./types"

/** Domain SDK bound to one immutable execution and one registered runtime authority. */
export interface Sixb<
  TOntologySources extends readonly OntologySource[] = readonly OntologySource[],
> {
  readonly execution: ExecutionContext
  readonly objects: ObjectsRuntime<TOntologySources>
  readonly actions: ActionsRuntime
  readonly datasets: DatasetsRuntime
  readonly workflows: WorkflowsRuntime
  readonly syncs: SyncsRuntime
  readonly pipelines: PipelinesRuntime
  readonly projections: ProjectionsRuntime
  readonly rules: RulesRuntime
  readonly agents: AgentsRuntime
  readonly events: EventsRuntime
  readonly logs: LogsRuntime
  readonly schedules: SchedulesRuntime
  readonly connector: ConnectorRuntime
  readonly blobs: BlobsRuntime
}

const boundSixbInstances = new WeakSet<object>()

export interface SixbDependencies {
  readonly definitions: SixbDefinitions
  readonly logging: LoggingService
  readonly connectorService: ConnectorService
  readonly connectorConnections?: ConnectorConnectionProcess
  readonly blobStorage: BlobStorage
}

export function createBoundSixb<TOntologySources extends readonly OntologySource[]>(
  runtime: SixbRuntimeContext,
  dependencies: SixbDependencies,
  execution: ExecutionContext
): Sixb<TOntologySources> {
  const sixb: Sixb<TOntologySources> = {
    execution,
    ...createExecutionFacades<TOntologySources>(runtime, execution, dependencies),
  }
  shareOntologyMutationRuntime(runtime, sixb)
  if (dependencies.connectorConnections) {
    registerConnectorConnectionsRuntime(
      sixb,
      createConnectorConnectionsRuntime(runtime, execution, dependencies.connectorConnections)
    )
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
  execution: ExecutionContext,
  dependencies: SixbDependencies
): Omit<Sixb<TOntologySources>, "execution"> {
  return {
    objects: createObjectsRuntime<TOntologySources>(runtime, execution),
    actions: createActionsRuntime(runtime, execution),
    datasets: createDatasetsRuntime(runtime, dependencies.definitions.datasets),
    workflows: createWorkflowsRuntime(runtime, execution, dependencies.definitions.workflows),
    syncs: createSyncsRuntime(runtime, execution, dependencies.definitions.syncs),
    pipelines: createPipelinesRuntime(runtime, execution, dependencies.definitions.pipelines),
    projections: createProjectionsRuntime(runtime, dependencies.definitions.projections),
    rules: createRulesRuntime(runtime, dependencies.definitions.rules),
    agents: createAgentsRuntime(
      runtime,
      execution,
      dependencies.definitions.agents,
      dependencies.definitions.security,
      dependencies.definitions.models
    ),
    events: createEventsRuntime(runtime),
    logs: createLogsRuntime(runtime, dependencies.logging),
    schedules: createSchedulesRuntime(dependencies.definitions.schedules),
    connector: createConnectorRuntime(runtime, execution, dependencies.connectorService),
    blobs: createBlobsRuntime(runtime, execution, dependencies.blobStorage),
  }
}
