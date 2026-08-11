import { pathToFileURL } from "node:url"
import type { SixbHostRuntime } from "@sixb/core"

export type LoadedSixbHost = SixbHostRuntime

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof value === "object" && "then" in value
}

const REQUIRED_HOST_PROPERTIES = [
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
  "withScope",
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
    isRecord(value.objects) &&
    hasMethods(value.objects, ["listTypes", "listSubTypes"]) &&
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
    typeof value.connector === "function" &&
    isRecord(value.connectors) &&
    hasMethods(value.connectors, ["list", "getById", "disconnectAll"]) &&
    isRecord(value.blobs) &&
    hasMethods(value.blobs, ["put", "open", "stat"])
  )
}

function isSixbHost(value: unknown): value is LoadedSixbHost {
  if (!isRecord(value)) return false

  return (
    typeof value.id === "string" &&
    typeof value.projectId === "string" &&
    hasProperties(value, REQUIRED_HOST_PROPERTIES) &&
    hasMethods(value, REQUIRED_LIFECYCLE_METHODS) &&
    hasPrimitiveFacades(value) &&
    hasWorkflows(value)
  )
}

export async function loadSixbFromEntry(entry: string): Promise<LoadedSixbHost> {
  const module = (await import(pathToFileURL(entry).href)) as Record<string, unknown>
  const candidate = module.sixb ?? module.default

  if (isSixbHost(candidate)) {
    return candidate
  }

  if (typeof candidate === "function") {
    const created = (candidate as () => unknown)()
    const resolved = isPromiseLike(created) ? await created : created
    if (isSixbHost(resolved)) {
      return resolved
    }
  }

  if (isPromiseLike(candidate)) {
    const resolved = await candidate
    if (isSixbHost(resolved)) {
      return resolved
    }
  }

  throw new Error(
    "Could not load a Sixb host from entry. Export `sixb` (or default) as a SixbHost or Promise<SixbHost>."
  )
}
