import { pathToFileURL } from "node:url"
import type {
  ActionsRuntime,
  BlobsRuntime,
  Broker,
  ConnectorsRuntime,
  DatasetsRuntime,
  OntologyMaintenanceHandle,
  OntologyOperationalStatus,
  PipelinesRuntime,
  ProjectionsRuntime,
  RulesRuntime,
  SchedulesRuntime,
  SixbReadiness,
  SixbRuntimeContext,
  SyncsRuntime,
} from "@sixb/core"
import type { AgentsRuntime } from "@sixb/core/internal/agents"
import type { AuthRuntime } from "@sixb/core/internal/auth"
import type { WorkflowsRuntime } from "@sixb/core/internal/workflows"
import type { ObjectRow } from "@sixb/core/storage"

interface LoadedObjectsRuntime {
  listTypes(): readonly unknown[]
  listSubTypes(objectTypeId: string): string[]
  list(params: {
    objectTypeIds?: readonly string[]
    limit?: number
    offset?: number
  }): Promise<{ total: number; hasMore: boolean; objects: ObjectRow[] }>
}

export interface LoadedSixb extends Omit<SixbRuntimeContext, "blobStorage" | "rules"> {
  readonly id: string
  readonly broker: Broker
  readonly auth: AuthRuntime
  readonly objects: LoadedObjectsRuntime
  readonly actions: ActionsRuntime
  readonly datasets: DatasetsRuntime
  readonly syncs: SyncsRuntime
  readonly pipelines: PipelinesRuntime
  readonly schedules: SchedulesRuntime
  readonly rules: RulesRuntime
  readonly projections: ProjectionsRuntime
  readonly connectors: ConnectorsRuntime
  readonly blobs: BlobsRuntime
  readonly workflows: WorkflowsRuntime
  readonly agents: AgentsRuntime
  startOntologyMaintenance(): Promise<OntologyMaintenanceHandle>
  getOntologyOperationalStatus(): OntologyOperationalStatus
  checkReadiness(): Promise<SixbReadiness>
  closeLogger(): Promise<void>
  closeBroker(): Promise<void>
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
  "blobs",
  "queues",
  "auth",
  "agents",
] as const

const REQUIRED_LIFECYCLE_METHODS = [
  "startOntologyMaintenance",
  "getOntologyOperationalStatus",
  "checkReadiness",
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

function hasMethods(value: unknown, methods: readonly PropertyKey[]): boolean {
  if (!isRecord(value) && typeof value !== "function") return false
  const candidate = value as Record<PropertyKey, unknown>
  return methods.every((method) => typeof candidate[method] === "function")
}

function hasWorkflows(value: Record<PropertyKey, unknown>): boolean {
  return isRecord(value.workflows) && hasMethods(value.workflows, ["list", "getById"])
}

function hasPrimitiveFacades(value: Record<PropertyKey, unknown>): boolean {
  return (
    typeof value.objects === "function" &&
    hasMethods(value.objects, ["listTypes", "listSubTypes", "list"]) &&
    isRecord(value.actions) &&
    hasMethods(value.actions, ["list", "getById"]) &&
    isRecord(value.datasets) &&
    hasMethods(value.datasets, ["list", "getById"]) &&
    isRecord(value.syncs) &&
    hasMethods(value.syncs, ["list", "getById"]) &&
    isRecord(value.pipelines) &&
    hasMethods(value.pipelines, ["list", "getById"]) &&
    isRecord(value.schedules) &&
    hasMethods(value.schedules, ["list", "getById", "start", "stop"]) &&
    isRecord(value.rules) &&
    hasMethods(value.rules, ["list", "getById"]) &&
    isRecord(value.projections) &&
    hasMethods(value.projections, [
      "list",
      "listObjects",
      "listLinks",
      "listTelemetry",
      "getById",
    ]) &&
    isRecord(value.connectors) &&
    hasMethods(value.connectors, ["list", "getById", "connect", "disconnectAll"]) &&
    isRecord(value.blobs) &&
    hasMethods(value.blobs, ["put", "open", "stat"])
  )
}

function isSixbInstance(value: unknown): value is LoadedSixb {
  if (!isRecord(value)) return false

  return (
    typeof value.id === "string" &&
    typeof value.projectId === "string" &&
    hasProperties(value, REQUIRED_RUNTIME_PROPERTIES) &&
    hasMethods(value, REQUIRED_LIFECYCLE_METHODS) &&
    hasPrimitiveFacades(value) &&
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
