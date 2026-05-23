import { pathToFileURL } from "node:url"
import type {
  ActionDefinition,
  AuthRuntime,
  ConnectorAdapter,
  ConnectorClient,
  ConnectorDefinition,
  DatasetDefinition,
  FunctionDefinition,
  LinkProjectionDefinition,
  ObjectProjectionDefinition,
  ObjectRow,
  PipelineDefinition,
  ProjectionDefinition,
  RuleDefinition,
  ScheduleDefinition,
  SixbRuntimeContext,
  SyncDefinition,
  WorkflowsRuntime,
} from "@sixb/core"

export interface LoadedSixb extends SixbRuntimeContext {
  readonly id: string
  readonly auth: AuthRuntime
  listObjectTypes(): readonly unknown[]
  getFunctionDefinitions(): readonly FunctionDefinition[]
  getActionDefinitions(): readonly ActionDefinition[]
  getActionById(actionId: string): ActionDefinition | null
  getSyncDefinitions(): readonly SyncDefinition[]
  getPipelineDefinitions(): readonly PipelineDefinition[]
  getPipelineById(pipelineId: string): PipelineDefinition | null
  getScheduleDefinitions(): readonly ScheduleDefinition[]
  readonly workflows: WorkflowsRuntime
  getObjectProjections(): readonly ObjectProjectionDefinition[]
  getLinkProjections(): readonly LinkProjectionDefinition[]
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
  startFunctions(): Promise<void>
  stopFunctions(): Promise<void>
  startScheduler(): Promise<void>
  stopScheduler(): Promise<void>
  disconnectConnectors(): Promise<void>
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

function isSixbInstance(value: unknown): value is LoadedSixb {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { projectId?: unknown }).projectId === "string" &&
    "ontology" in value &&
    "actionRegistry" in value &&
    "events" in value &&
    "storage" in value &&
    "lakeStorage" in value &&
    "blobStorage" in value &&
    "queues" in value &&
    "auth" in value &&
    typeof (value as { listObjectTypes?: unknown }).listObjectTypes === "function" &&
    typeof (value as { getSubTypes?: unknown }).getSubTypes === "function" &&
    typeof (value as { getFunctionDefinitions?: unknown }).getFunctionDefinitions === "function" &&
    typeof (value as { getActionDefinitions?: unknown }).getActionDefinitions === "function" &&
    typeof (value as { getActionById?: unknown }).getActionById === "function" &&
    typeof (value as { getSyncDefinitions?: unknown }).getSyncDefinitions === "function" &&
    typeof (value as { getPipelineDefinitions?: unknown }).getPipelineDefinitions === "function" &&
    typeof (value as { getPipelineById?: unknown }).getPipelineById === "function" &&
    typeof (value as { getScheduleDefinitions?: unknown }).getScheduleDefinitions === "function" &&
    typeof (value as { workflows?: { list?: unknown } }).workflows?.list === "function" &&
    typeof (value as { workflows?: { getById?: unknown } }).workflows?.getById === "function" &&
    typeof (value as { getObjectProjections?: unknown }).getObjectProjections === "function" &&
    typeof (value as { getLinkProjections?: unknown }).getLinkProjections === "function" &&
    typeof (value as { getDatasetDefinitions?: unknown }).getDatasetDefinitions === "function" &&
    typeof (value as { getRuleDefinitions?: unknown }).getRuleDefinitions === "function" &&
    typeof (value as { getDatasetById?: unknown }).getDatasetById === "function" &&
    typeof (value as { getProjectionById?: unknown }).getProjectionById === "function" &&
    typeof (value as { getSyncById?: unknown }).getSyncById === "function" &&
    typeof (value as { getRuleById?: unknown }).getRuleById === "function" &&
    typeof (value as { getPipelineById?: unknown }).getPipelineById === "function" &&
    typeof (value as { startFunctions?: unknown }).startFunctions === "function" &&
    typeof (value as { stopFunctions?: unknown }).stopFunctions === "function" &&
    typeof (value as { startScheduler?: unknown }).startScheduler === "function" &&
    typeof (value as { stopScheduler?: unknown }).stopScheduler === "function" &&
    typeof (value as { disconnectConnectors?: unknown }).disconnectConnectors === "function" &&
    typeof (value as { closeBroker?: unknown }).closeBroker === "function"
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
