import { pathToFileURL } from "node:url"
import type { SixbHostView } from "@sixb/core"

export type LoadedSixbHost = SixbHostView

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof value === "object" && "then" in value
}

const REQUIRED_HOST_PROPERTIES = [
  "definitions",
  "events",
  "logging",
  "broker",
  "storage",
  "lakeStorage",
  "blobStorage",
  "queues",
  "auth",
] as const

const REQUIRED_LIFECYCLE_METHODS = [
  "withScope",
  "startMaintenance",
  "startOntologyMaintenance",
  "getOntologyOperationalStatus",
  "prepareReadiness",
  "checkReadiness",
  "closeLogger",
  "closeConnectors",
  "closeBlobs",
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

function hasDefinitionCatalogs(value: Record<PropertyKey, unknown>): boolean {
  if (!isRecord(value.definitions)) return false
  const definitions = value.definitions
  return (
    isRecord(definitions.ontology) &&
    hasMethods(definitions.ontology, ["listObjectTypes", "getObjectTypeById"]) &&
    isRecord(definitions.actions) &&
    hasMethods(definitions.actions, ["list", "getById", "listGlobal", "listForType"]) &&
    isRecord(definitions.connectors) &&
    hasMethods(definitions.connectors, ["list", "getById"]) &&
    isRecord(definitions.datasets) &&
    hasMethods(definitions.datasets, ["list", "getById"]) &&
    isRecord(definitions.syncs) &&
    hasMethods(definitions.syncs, ["list", "getById"]) &&
    isRecord(definitions.pipelines) &&
    hasMethods(definitions.pipelines, ["list", "getById"]) &&
    isRecord(definitions.schedules) &&
    hasMethods(definitions.schedules, ["list", "getById"]) &&
    isRecord(definitions.rules) &&
    hasMethods(definitions.rules, ["list", "getById"]) &&
    isRecord(definitions.projections) &&
    hasMethods(definitions.projections, [
      "list",
      "listObjects",
      "listLinks",
      "listTelemetry",
      "getById",
    ]) &&
    isRecord(definitions.workflows) &&
    hasMethods(definitions.workflows, ["list", "getById"]) &&
    isRecord(definitions.security) &&
    hasMethods(definitions.security, [
      "listGroups",
      "getGroupById",
      "listRoles",
      "getRoleById",
      "listResolvedRoles",
      "listMembershipPolicies",
      "getMembershipPolicyById",
    ])
  )
}

function isSixbHost(value: unknown): value is LoadedSixbHost {
  if (!isRecord(value)) return false

  return (
    typeof value.id === "string" &&
    typeof value.projectId === "string" &&
    hasProperties(value, REQUIRED_HOST_PROPERTIES) &&
    hasMethods(value, REQUIRED_LIFECYCLE_METHODS) &&
    hasDefinitionCatalogs(value) &&
    isRecord(value.logging) &&
    hasMethods(value.logging, ["startExecution", "read", "tail"]) &&
    isRecord(value.blobStorage) &&
    hasMethods(value.blobStorage, ["put", "open", "stat"])
  )
}

/**
 * Every command loads the project here. The branch it was started for, `SIXB_BRANCH`, is read
 * before the project's code runs, and the host must run as that branch: a project that changes the
 * variable, or hands back a host built otherwise, does not start.
 */
export async function loadSixbFromEntry(entry: string): Promise<LoadedSixbHost> {
  const branch = process.env.SIXB_BRANCH

  return assertHostBranch(await importSixbHost(entry), branch)
}

/** Refuse a host that does not run as the branch the command was started for. */
export function assertHostBranch(
  host: LoadedSixbHost,
  expected: string | undefined
): LoadedSixbHost {
  const actual = host.branch?.name
  if (actual === expected) return host

  const wanted = expected === undefined ? "off any branch" : `on branch "${expected}"`
  const found = actual === undefined ? "off any branch" : `on branch "${actual}"`

  throw new Error(
    `[SixbCLI] This command was started ${wanted}, but the project's host runs ${found}. ` +
      "Leave SIXB_BRANCH and SIXB_BRANCH_DATA_FROM to the CLI, and export the host createSixb() returns."
  )
}

async function importSixbHost(entry: string): Promise<LoadedSixbHost> {
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
