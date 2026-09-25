import { type ActionsRuntime, createActionsRuntime } from "../actions/execution"
import { type AgentRuntime, createAgentRuntime } from "../agents/execution"
import { type AiUsageRuntime, createAiUsageRuntime } from "../ai-usage"
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
import { resolveExecutionScopeAuthorization } from "../execution/authorization"
import { assertAuthorizedObjectReaderBinding } from "../execution/authorized-object-reader"
import type { LakeStorage } from "../lake-storage/types"
import { createLogsRuntime, type LogsRuntime } from "../logging/execution"
import type { LoggingService } from "../logging/service"
import { createModelsRuntime } from "../models/execution"
import type { ModelsRuntime } from "../models/generation-types"
import { createObjectsRuntime, type ObjectsRuntime } from "../objects/execution"
import { createPipelinesRuntime, type PipelinesRuntime } from "../pipelines/execution"
import { createProjectionsRuntime, type ProjectionsRuntime } from "../projections/execution"
import { createRulesRuntime, type RulesRuntime } from "../rules/execution"
import type { SandboxDefinition } from "../sandboxes/configuration"
import { createSchedulesRuntime, type SchedulesRuntime } from "../schedules/execution"
import { createSharesRuntime, type SharesRuntime } from "../shares/execution"
import { createSyncsRuntime, type SyncsRuntime } from "../syncs/execution"
import { createWorkflowsRuntime, type WorkflowsRuntime } from "../workflows/execution"
import type { SixbDefinitions } from "./definitions"
import { shareOntologyMutationRuntime } from "./ontology-mutations"
import type { SixbRuntimeContext } from "./types"

/** Domain SDK bound to one immutable execution and one registered runtime authority. */
export interface Sixb<TParams extends Record<string, unknown> = Record<string, unknown>> {
  readonly execution: ExecutionContext
  readonly objects: ObjectsRuntime
  readonly actions: ActionsRuntime
  readonly datasets: DatasetsRuntime
  readonly workflows: WorkflowsRuntime
  readonly syncs: SyncsRuntime
  readonly pipelines: PipelinesRuntime
  readonly projections: ProjectionsRuntime
  readonly rules: RulesRuntime
  readonly agent: AgentRuntime<TParams>
  readonly models: ModelsRuntime
  readonly aiUsage: AiUsageRuntime
  readonly events: EventsRuntime
  readonly logs: LogsRuntime
  readonly schedules: SchedulesRuntime
  readonly shares: SharesRuntime
  readonly connector: ConnectorRuntime
  readonly blobs: BlobsRuntime
}

const boundSixbInstances = new WeakSet<object>()

export interface SixbDependencies {
  readonly sandbox?: {
    readonly definition: SandboxDefinition
    readonly supportsPersistence: boolean
  }
  readonly definitions: SixbDefinitions
  readonly logging: LoggingService
  readonly connectorService: ConnectorService
  readonly connectorConnections?: ConnectorConnectionProcess
  readonly blobStorage: BlobStorage
  readonly lakeStorage: LakeStorage
}

export function createBoundSixb<TParams extends Record<string, unknown> = Record<string, unknown>>(
  runtime: SixbRuntimeContext,
  dependencies: SixbDependencies,
  execution: ExecutionContext
): Sixb<TParams> {
  resolveExecutionScopeAuthorization(runtime.projectId, {
    execution,
    authorization: runtime.runtimeAuthorization,
  })
  assertAuthorizedObjectReaderBinding({
    reader: runtime.objectReader,
    scope: { execution, authorization: runtime.runtimeAuthorization },
  })
  const sixb: Sixb<TParams> = {
    execution,
    ...createExecutionFacades<TParams>(runtime, execution, dependencies),
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
export function isBoundSixb<TParams extends Record<string, unknown> = Record<string, unknown>>(
  value: unknown
): value is Sixb<TParams> {
  return typeof value === "object" && value !== null && boundSixbInstances.has(value)
}

function createExecutionFacades<TParams extends Record<string, unknown>>(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  dependencies: SixbDependencies
): Omit<Sixb<TParams>, "execution"> {
  return {
    objects: createObjectsRuntime(runtime, execution),
    actions: createActionsRuntime(runtime, execution),
    datasets: createDatasetsRuntime(
      runtime,
      execution,
      dependencies.definitions.datasets,
      dependencies.lakeStorage,
      dependencies.blobStorage
    ),
    workflows: createWorkflowsRuntime(runtime, execution, dependencies.definitions.workflows),
    syncs: createSyncsRuntime(runtime, execution, dependencies.definitions.syncs),
    pipelines: createPipelinesRuntime(runtime, execution, dependencies.definitions.pipelines),
    projections: createProjectionsRuntime(runtime, dependencies.definitions.projections),
    rules: createRulesRuntime(runtime, dependencies.definitions.rules),
    agent: createAgentRuntime<TParams>(
      runtime,
      execution,
      dependencies.definitions.models,
      dependencies.sandbox
    ),
    models: createModelsRuntime(runtime, execution, dependencies.definitions.models),
    aiUsage: createAiUsageRuntime(runtime, dependencies.definitions.security),
    events: createEventsRuntime(runtime),
    logs: createLogsRuntime(runtime, dependencies.logging),
    schedules: createSchedulesRuntime(runtime, dependencies.definitions.schedules),
    shares: createSharesRuntime(runtime, execution, dependencies.definitions.shares),
    connector: createConnectorRuntime(runtime, execution, dependencies.connectorService),
    blobs: createBlobsRuntime(runtime, execution, dependencies.blobStorage),
  }
}
