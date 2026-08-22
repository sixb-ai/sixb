/**
 * Filesystem auto-discovery for convention-based module loading.
 *
 * Scans well-known definition directories (`ontology/`, `actions/`, etc.)
 * relative to a project root and returns typed definition arrays ready
 * for the `Sixb` constructor.
 */

import { readdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { isActionDefinition } from "../actions"
import { isAgentDefinition } from "../agents"
import { isConnectorDefinition } from "../connectors"
import { isDatasetDefinition } from "../datasets"
import type { OntologyDocumentInput, OntologySource } from "../ontology/registry"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import type { ValueType } from "../ontology/types"
import { isPipelineDefinition } from "../pipelines"
import { isProjectionDefinition } from "../projections/builders"
import { isRuleDefinition } from "../rules"
import { RuntimeError } from "../runtime/errors"
import { isScheduleDefinition } from "../schedules"
import { isGroupDefinition, isMembershipPolicyDefinition, isRoleDefinition } from "../security"
import { isSyncDefinition } from "../syncs"
import { isWorkflowDefinition } from "../workflows"

const moduleExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])

export async function discoverOntologySources(
  projectRoot: string
): Promise<readonly OntologySource[]> {
  const ontologyDir = join(projectRoot, "ontology")
  const modulePaths = await listModuleFiles(ontologyDir)
  const exportedCandidates = await loadModuleExports({
    modulePaths,
    projectRoot,
    kind: "ontology",
  })

  const ontologyDocuments: OntologyDocumentInput[] = []
  const objectTypes: ObjectTypeWithPropertyTokens[] = []
  const valueTypes: ValueType[] = []

  for (const candidate of exportedCandidates) {
    if (isOntologyDocumentInput(candidate)) {
      ontologyDocuments.push(candidate)
      continue
    }

    if (isObjectTypeWithPropertyTokens(candidate)) {
      objectTypes.push(candidate)
      continue
    }

    if (isValueType(candidate)) {
      valueTypes.push(candidate)
    }
  }

  const discoveredSources: OntologySource[] = [...ontologyDocuments, ...objectTypes]
  if (valueTypes.length > 0) {
    discoveredSources.push({
      id: "__sixb.discovered.value-types__",
      version: "0.0.0",
      objectTypes: [],
      valueTypes,
    })
  }

  return discoveredSources
}

type DiscoveryModuleKind =
  | "action"
  | "agent"
  | "connector"
  | "dataset"
  | "group"
  | "membershipPolicy"
  | "ontology"
  | "pipeline"
  | "projection"
  | "role"
  | "rule"
  | "schedule"
  | "sync"
  | "workflow"

interface DefinitionDiscoveryFamily<TDefinition> {
  readonly directory: readonly string[]
  readonly kind: Exclude<DiscoveryModuleKind, "ontology">
  readonly isDefinition: (value: unknown) => value is TDefinition
}

const definitionDiscoveryRegistry = {
  actions: { directory: ["actions"], kind: "action", isDefinition: isActionDefinition },
  projections: {
    directory: ["projections"],
    kind: "projection",
    isDefinition: isProjectionDefinition,
  },
  schedules: {
    directory: ["schedules"],
    kind: "schedule",
    isDefinition: isScheduleDefinition,
  },
  syncs: { directory: ["syncs"], kind: "sync", isDefinition: isSyncDefinition },
  connectors: {
    directory: ["connectors"],
    kind: "connector",
    isDefinition: isConnectorDefinition,
  },
  pipelines: {
    directory: ["pipelines"],
    kind: "pipeline",
    isDefinition: isPipelineDefinition,
  },
  datasets: { directory: ["datasets"], kind: "dataset", isDefinition: isDatasetDefinition },
  rules: { directory: ["rules"], kind: "rule", isDefinition: isRuleDefinition },
  workflows: {
    directory: ["workflows"],
    kind: "workflow",
    isDefinition: isWorkflowDefinition,
  },
  groups: {
    directory: ["security", "groups"],
    kind: "group",
    isDefinition: isGroupDefinition,
  },
  roles: {
    directory: ["security", "roles"],
    kind: "role",
    isDefinition: isRoleDefinition,
  },
  membershipPolicies: {
    directory: ["security", "policies"],
    kind: "membershipPolicy",
    isDefinition: isMembershipPolicyDefinition,
  },
  agents: { directory: ["agents"], kind: "agent", isDefinition: isAgentDefinition },
} as const satisfies Record<string, DefinitionDiscoveryFamily<unknown>>

type DefinitionFromFamily<TFamily> =
  TFamily extends DefinitionDiscoveryFamily<infer TDefinition> ? TDefinition : never

export type DiscoveredProjectDefinitions = {
  readonly [TKey in keyof typeof definitionDiscoveryRegistry]: readonly DefinitionFromFamily<
    (typeof definitionDiscoveryRegistry)[TKey]
  >[]
}

export async function discoverProjectDefinitions(
  projectRoot: string
): Promise<DiscoveredProjectDefinitions> {
  const entries = await Promise.all(
    Object.entries(definitionDiscoveryRegistry).map(async ([key, family]) => {
      const definitions = await discoverDefinitionFamily(projectRoot, family)
      return [key, definitions] as const
    })
  )

  // Object.fromEntries erases literal keys. Every entry above comes from the exact registry and its
  // definitions have passed that entry's type guard, so restoring the mapped result type is safe.
  return Object.fromEntries(entries) as DiscoveredProjectDefinitions
}

async function discoverDefinitionFamily(
  projectRoot: string,
  family: DefinitionDiscoveryFamily<unknown>
): Promise<readonly unknown[]> {
  const modulePaths = await listModuleFiles(join(projectRoot, ...family.directory))
  const exportedCandidates = await loadModuleExports({
    modulePaths,
    projectRoot,
    kind: family.kind,
  })

  return exportedCandidates.filter(family.isDefinition)
}

// ── Internal helpers ────────────────────────────────────────

async function loadModuleExports(options: {
  modulePaths: readonly string[]
  projectRoot: string
  kind: DiscoveryModuleKind
}): Promise<unknown[]> {
  const exportedCandidates: unknown[] = []
  const seen = new Set<unknown>()

  for (const modulePath of options.modulePaths) {
    let moduleNamespace: Record<string, unknown>
    try {
      moduleNamespace = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>
    } catch (error) {
      const relPath = relative(options.projectRoot, modulePath)
      const reason = error instanceof Error ? error.message : String(error)
      throw new RuntimeError(`Failed to load ${options.kind} module '${relPath}': ${reason}`)
    }

    for (const exportedValue of Object.values(moduleNamespace)) {
      collectExportedCandidates(exportedValue, exportedCandidates, seen)
    }
  }

  return exportedCandidates
}

function collectExportedCandidates(value: unknown, target: unknown[], seen: Set<unknown>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectExportedCandidates(item, target, seen)
    }
    return
  }

  if (value === undefined) {
    return
  }

  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    if (seen.has(value)) {
      return
    }
    seen.add(value)
  }

  target.push(value)
}

async function listModuleFiles(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as import("node:fs").Dirent[]
  } catch (error) {
    if (isNotFoundError(error)) {
      return []
    }
    throw error
  }

  const files: string[] = []
  const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name))

  for (const entry of sortedEntries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listModuleFiles(fullPath)))
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    if (!hasSupportedModuleExtension(entry.name)) {
      continue
    }

    files.push(fullPath)
  }

  return files
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const code = (error as NodeJS.ErrnoException).code
  return code === "ENOENT" || code === "ENOTDIR"
}

function hasSupportedModuleExtension(fileName: string): boolean {
  const normalized = fileName.toLowerCase()
  for (const extension of moduleExtensions) {
    if (normalized.endsWith(extension)) {
      return true
    }
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isOntologyDocumentInput(value: unknown): value is OntologyDocumentInput {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.id === "string" &&
    typeof value.version === "string" &&
    Array.isArray(value.objectTypes)
  )
}

function isObjectTypeWithPropertyTokens(value: unknown): value is ObjectTypeWithPropertyTokens {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.id === "string" &&
    Array.isArray(value.properties) &&
    Array.isArray(value.links) &&
    isRecord(value.p)
  )
}

function isValueType(value: unknown): value is ValueType {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    "schema" in value &&
    !Array.isArray(value.properties) &&
    !Array.isArray(value.objectTypes)
  )
}
