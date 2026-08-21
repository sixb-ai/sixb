import { type ActionsRuntime, createActionsRuntime } from "../actions/execution"
import { type AgentsRuntime, createAgentsRuntime } from "../agents/execution"
import { type BlobsRuntime, createBlobsRuntime } from "../blob-storage/execution"
import type { BlobStorage } from "../blob-storage/types"
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
import { createSharesRuntime, type SharesRuntime } from "../shares"
import { createSyncsRuntime, type SyncsRuntime } from "../syncs/execution"
import { createWorkflowsRuntime, type WorkflowsRuntime } from "../workflows/execution"
import type { SixbDefinitions } from "./definitions"
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
  readonly shares: SharesRuntime
}

const boundSixbInstances = new WeakSet<object>()

export interface SixbDependencies {
  readonly definitions: SixbDefinitions
  readonly logging: LoggingService
  readonly connectorService: ConnectorService
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
  const objects = createObjectsRuntime<TOntologySources>(runtime, execution)
  return {
    objects,
    actions: createActionsRuntime(runtime, execution),
    datasets: createDatasetsRuntime(runtime, dependencies.definitions.datasets),
    workflows: createWorkflowsRuntime(runtime, execution, dependencies.definitions.workflows),
    syncs: createSyncsRuntime(runtime, dependencies.definitions.syncs),
    pipelines: createPipelinesRuntime(runtime, dependencies.definitions.pipelines),
    projections: createProjectionsRuntime(runtime, dependencies.definitions.projections),
    rules: createRulesRuntime(runtime, dependencies.definitions.rules),
    agents: createAgentsRuntime(
      runtime,
      execution,
      dependencies.definitions.agents,
      dependencies.definitions.security
    ),
    events: createEventsRuntime(runtime),
    logs: createLogsRuntime(runtime, dependencies.logging),
    schedules: createSchedulesRuntime(dependencies.definitions.schedules),
    connector: createConnectorRuntime(runtime, execution, dependencies.connectorService),
    blobs: createBlobsRuntime(runtime, execution, dependencies.blobStorage),
    shares: createSharesRuntime(runtime, execution, dependencies.definitions.shares, objects),
  }
}
