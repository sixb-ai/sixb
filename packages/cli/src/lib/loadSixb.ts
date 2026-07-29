import { pathToFileURL } from "node:url"
import type {
  ActionDefinition,
  Broker,
  ConnectorAdapter,
  ConnectorClient,
  ConnectorDefinition,
  DatasetDefinition,
  LinkProjectionDefinition,
  ObjectProjectionDefinition,
  OntologyMaintenanceHandle,
  OntologyOperationalStatus,
  PipelineDefinition,
  ProjectionDefinition,
  RuleDefinition,
  ScheduleDefinition,
  SixbReadiness,
  SixbRuntimeContext,
  SyncDefinition,
  TelemetryProjectionDefinition,
} from "@sixb/core"
import type { AgentsRuntime } from "@sixb/core/internal/agents"
import type { AuthRuntime } from "@sixb/core/internal/auth"
import type { WorkflowsRuntime } from "@sixb/core/internal/workflows"
import type { ObjectRow } from "@sixb/core/storage"

export interface LoadedSixb extends SixbRuntimeContext {
  readonly id: string
  readonly broker: Broker
  readonly auth: AuthRuntime
  listObjectTypes(): readonly unknown[]
  getActionDefinitions(): readonly ActionDefinition[]
  getActionById(actionId: string): ActionDefinition | null
  getSyncDefinitions(): readonly SyncDefinition[]
  getPipelineDefinitions(): readonly PipelineDefinition[]
  getPipelineById(pipelineId: string): PipelineDefinition | null
  getScheduleDefinitions(): readonly ScheduleDefinition[]
  readonly workflows: WorkflowsRuntime
  readonly agents: AgentsRuntime
  getObjectProjections(): readonly ObjectProjectionDefinition[]
  getLinkProjections(): readonly LinkProjectionDefinition[]
  getTelemetryProjections(): readonly TelemetryProjectionDefinition[]
  getDatasetDefinitions(): readonly DatasetDefinition[]
  getRuleDefinitions(): readonly RuleDefinition[]
  getDatasetById(datasetId: string): DatasetDefinition | null
  getProjectionById(projectionId: string): ProjectionDefinition | null
  getSyncById(syncId: string): SyncDefinition | null
  getRuleById(ruleId: string): RuleDefinition | null
  getSubTypes(objectTypeId: string): string[]
  connector<TAdapter extends ConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>
  ): Promise<ConnectorClient<TAdapter>>
  startScheduler(): Promise<void>
  stopScheduler(): Promise<void>
  startOntologyMaintenance(): Promise<OntologyMaintenanceHandle>
  getOntologyOperationalStatus(): OntologyOperationalStatus
  checkReadiness(): Promise<SixbReadiness>
  disconnectConnectors(): Promise<void>
  closeLogger(): Promise<void>
  closeBroker(): Promise<void>
  list(params: {
    objectTypeIds?: readonly string[]
    limit?: number
    offset?: number
  }): Promise<{ total: number; hasMore: boolean; objects: ObjectRow[] }>
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof value === "object" && "then" in value
}

const REQUIRED_RUNTIME_PROPERTIES = [
  "ontology",
  "actionRegistry",
  "events",
  "broker",
  "storage",
  "lakeStorage",
  "blobStorage",
  "queues",
  "auth",
  "agents",
] as const

const REQUIRED_DEFINITION_METHODS = [
  "listObjectTypes",
  "getSubTypes",
  "getActionDefinitions",
  "getActionById",
  "getSyncDefinitions",
  "getPipelineDefinitions",
  "getPipelineById",
  "getScheduleDefinitions",
  "getObjectProjections",
  "getLinkProjections",
  "getTelemetryProjections",
  "getDatasetDefinitions",
  "getRuleDefinitions",
  "getDatasetById",
  "getProjectionById",
  "getSyncById",
  "getRuleById",
] as const

const REQUIRED_LIFECYCLE_METHODS = [
  "startScheduler",
  "stopScheduler",
  "startOntologyMaintenance",
  "getOntologyOperationalStatus",
  "checkReadiness",
  "disconnectConnectors",
  "closeLogger",
  "closeBroker",
] as const

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === "object"
}

function hasProperties(
  value: Record<PropertyKey, unknown>,
  properties: readonly PropertyKey[]
): boolean {
  return properties.every((property) => property in value)
}

function hasMethods(value: Record<PropertyKey, unknown>, methods: readonly PropertyKey[]): boolean {
  return methods.every((method) => typeof value[method] === "function")
}

function hasWorkflows(value: Record<PropertyKey, unknown>): boolean {
  return isRecord(value.workflows) && hasMethods(value.workflows, ["list", "getById"])
}

function isSixbInstance(value: unknown): value is LoadedSixb {
  if (!isRecord(value)) return false

  return (
    typeof value.id === "string" &&
    typeof value.projectId === "string" &&
    hasProperties(value, REQUIRED_RUNTIME_PROPERTIES) &&
    hasMethods(value, REQUIRED_DEFINITION_METHODS) &&
    hasMethods(value, REQUIRED_LIFECYCLE_METHODS) &&
    hasMethods(value, ["connector", "list"]) &&
    hasWorkflows(value)
  )
}

export async function loadSixbFromEntry(entry: string): Promise<LoadedSixb> {
  const module = (await import(pathToFileURL(entry).href)) as Record<string, unknown>
  const candidate = module.sixb ?? module.default

  if (isSixbInstance(candidate)) {
    return candidate
  }

  if (typeof candidate === "function") {
    const created = (candidate as () => unknown)()
    const resolved = isPromiseLike(created) ? await created : created
    if (isSixbInstance(resolved)) {
      return resolved
    }
  }

  if (isPromiseLike(candidate)) {
    const resolved = await candidate
    if (isSixbInstance(resolved)) {
      return resolved
    }
  }

  throw new Error(
    "Could not load Sixb runtime from entry. Export `sixb` (or default) as a Sixb instance or Promise<Sixb>."
  )
}
