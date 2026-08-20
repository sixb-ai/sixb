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
import type { ActionDefinition } from "../actions/types"
import type { AgentDefinition } from "../agents"
import { isAgentDefinition } from "../agents"
import { isConnectorDefinition } from "../connectors"
import type { ConnectorDefinition } from "../connectors/types"
import { isDatasetDefinition } from "../datasets"
import type { DatasetDefinition } from "../datasets/types"
import type { OntologyDocumentInput, OntologySource } from "../ontology/registry"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import type { ValueType } from "../ontology/types"
import { isPipelineDefinition } from "../pipelines"
import type { PipelineDefinition } from "../pipelines/types"
import { isProjectionDefinition } from "../projections/builders"
import type { ProjectionDefinition } from "../projections/types"
import { isRuleDefinition } from "../rules"
import type { RuleDefinition } from "../rules/types"
import { RuntimeError } from "../runtime/errors"
import type { ScheduleDefinition } from "../schedules"
import { isScheduleDefinition } from "../schedules"
import type { GroupDefinition, MembershipPolicyDefinition, RoleDefinition } from "../security"
import { isGroupDefinition, isMembershipPolicyDefinition, isRoleDefinition } from "../security"
import type { ShareTypeDefinition } from "../shares"
import { isShareTypeDefinition } from "../shares"
import type { SyncDefinition } from "../syncs"
import { isSyncDefinition } from "../syncs"
import type { WorkflowDefinition } from "../workflows"
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

export async function discoverActions(projectRoot: string): Promise<readonly ActionDefinition[]> {
  const actionsDir = join(projectRoot, "actions")
  const modulePaths = await listModuleFiles(actionsDir)
  const exportedCandidates = await loadModuleExports({
    modulePaths,
    projectRoot,
    kind: "action",
  })

  const actions: ActionDefinition[] = []
  for (const candidate of exportedCandidates) {
    if (isActionDefinition(candidate)) {
      actions.push(candidate)
    }
  }

  return actions
}

export async function discoverDatasets(projectRoot: string): Promise<readonly DatasetDefinition[]> {
  const datasetsDir = join(projectRoot, "datasets")
  const modulePaths = await listModuleFiles(datasetsDir)
  const exportedCandidates = await loadModuleExports({
    modulePaths,
    projectRoot,
    kind: "dataset",
  })

  const datasets: DatasetDefinition[] = []
  for (const candidate of exportedCandidates) {
    if (isDatasetDefinition(candidate)) {
      datasets.push(candidate)
    }
  }

  return datasets
}

export async function discoverSyncs(projectRoot: string): Promise<readonly SyncDefinition[]> {
  const syncsDir = join(projectRoot, "syncs")
  const modulePaths = await listModuleFiles(syncsDir)
  const exportedCandidates = await loadModuleExports({
    modulePaths,
    projectRoot,
    kind: "sync",
  })

  const syncs: SyncDefinition[] = []
  for (const candidate of exportedCandidates) {
    if (isSyncDefinition(candidate)) {
      syncs.push(candidate)
    }
  }

  return syncs
}

export async function discoverProjections(
  projectRoot: string
): Promise<readonly ProjectionDefinition[]> {
  const projectionsDir = join(projectRoot, "projections")
  const modulePaths = await listModuleFiles(projectionsDir)
  const exportedCandidates = await loadModuleExports({
    modulePaths,
    projectRoot,
    kind: "projection",
  })

  const projections: ProjectionDefinition[] = []
  for (const candidate of exportedCandidates) {
    if (isProjectionDefinition(candidate)) {
      projections.push(candidate)
    }
  }

  return projections
}

export async function discoverConnectors(
  projectRoot: string
): Promise<readonly ConnectorDefinition[]> {
  const connectorsDir = join(projectRoot, "connectors")
  const modulePaths = await listModuleFiles(connectorsDir)
  const exportedCandidates = await loadModuleExports({
    modulePaths,
    projectRoot,
    kind: "connector",
  })

  const connectors: ConnectorDefinition[] = []
  for (const candidate of exportedCandidates) {
    if (isConnectorDefinition(candidate)) {
      connectors.push(candidate)
    }
  }

  return connectors
}

export async function discoverSchedules(
  projectRoot: string
): Promise<readonly ScheduleDefinition[]> {
  const schedulesDir = join(projectRoot, "schedules")
  const modulePaths = await listModuleFiles(schedulesDir)
  const exportedCandidates = await loadModuleExports({
    modulePaths,
    projectRoot,
    kind: "schedule",
  })

  const schedules: ScheduleDefinition[] = []
  for (const candidate of exportedCandidates) {
    if (isScheduleDefinition(candidate)) {
      schedules.push(candidate)
    }
  }

  return schedules
}

export async function discoverPipelines(
  projectRoot: string
): Promise<readonly PipelineDefinition[]> {
  const pipelinesDir = join(projectRoot, "pipelines")
  const modulePaths = await listModuleFiles(pipelinesDir)
  const exportedCandidates = await loadModuleExports({
    modulePaths,
    projectRoot,
    kind: "pipeline",
  })

  const pipelines: PipelineDefinition[] = []
  for (const candidate of exportedCandidates) {
    if (isPipelineDefinition(candidate)) {
      pipelines.push(candidate)
    }
  }

  return pipelines
}

export async function discoverRules(projectRoot: string): Promise<readonly RuleDefinition[]> {
  // Rules follow the same convention-based discovery model as syncs and workflows:
  // any exported rule definition, or arrays containing them, is collected.
  const rulesDir = join(projectRoot, "rules")
  const modulePaths = await listModuleFiles(rulesDir)
  const exportedCandidates = await loadModuleExports({
    modulePaths,
    projectRoot,
    kind: "rule",
  })

  const rules: RuleDefinition[] = []
  for (const candidate of exportedCandidates) {
    if (isRuleDefinition(candidate)) {
      rules.push(candidate)
    }
  }

  return rules
}

export async function discoverGroups(projectRoot: string): Promise<readonly GroupDefinition[]> {
  const groupsDir = join(projectRoot, "security", "groups")
  const modulePaths = await listModuleFiles(groupsDir)
  const exportedCandidates = await loadModuleExports({
    modulePaths,
    projectRoot,
    kind: "group",
  })

  const groups: GroupDefinition[] = []
  for (const candidate of exportedCandidates) {
    if (isGroupDefinition(candidate)) {
      groups.push(candidate)
    }
  }

  return groups
}

export async function discoverRoles(projectRoot: string): Promise<readonly RoleDefinition[]> {
  const rolesDir = join(projectRoot, "security", "roles")
  const modulePaths = await listModuleFiles(rolesDir)
  const exportedCandidates = await loadModuleExports({
    modulePaths,
    projectRoot,
    kind: "role",
  })

  const roles: RoleDefinition[] = []
  for (const candidate of exportedCandidates) {
    if (isRoleDefinition(candidate)) {
      roles.push(candidate)
    }
  }

  return roles
}

export async function discoverMembershipPolicies(
  projectRoot: string
): Promise<readonly MembershipPolicyDefinition[]> {
  const policiesDir = join(projectRoot, "security", "policies")
  const modulePaths = await listModuleFiles(policiesDir)
  const exportedCandidates = await loadModuleExports({
    modulePaths,
    projectRoot,
    kind: "membershipPolicy",
  })

  const membershipPolicies: MembershipPolicyDefinition[] = []
  for (const candidate of exportedCandidates) {
    if (isMembershipPolicyDefinition(candidate)) {
      membershipPolicies.push(candidate)
    }
  }

  return membershipPolicies
}

export async function discoverWorkflows(
  projectRoot: string
): Promise<readonly WorkflowDefinition[]> {
  const workflowsDir = join(projectRoot, "workflows")
  const modulePaths = await listModuleFiles(workflowsDir)
  const exportedCandidates = await loadModuleExports({
    modulePaths,
    projectRoot,
    kind: "workflow",
  })

  const workflows: WorkflowDefinition[] = []
  for (const candidate of exportedCandidates) {
    if (isWorkflowDefinition(candidate)) {
      workflows.push(candidate)
    }
  }

  return workflows
}

export async function discoverAgents(projectRoot: string): Promise<readonly AgentDefinition[]> {
  const agentsDir = join(projectRoot, "agents")
  const modulePaths = await listModuleFiles(agentsDir)
  const exportedCandidates = await loadModuleExports({
    modulePaths,
    projectRoot,
    kind: "agent",
  })

  const agents: AgentDefinition[] = []
  for (const candidate of exportedCandidates) {
    if (isAgentDefinition(candidate)) {
      agents.push(candidate)
    }
  }

  return agents
}

export async function discoverShares(projectRoot: string): Promise<readonly ShareTypeDefinition[]> {
  const sharesDir = join(projectRoot, "shares")
  const modulePaths = await listModuleFiles(sharesDir)
  const exportedCandidates = await loadModuleExports({
    modulePaths,
    projectRoot,
    kind: "share",
  })

  const shares: ShareTypeDefinition[] = []
  for (const candidate of exportedCandidates) {
    if (isShareTypeDefinition(candidate)) shares.push(candidate)
  }
  return shares
}

// ── Internal helpers ────────────────────────────────────────

async function loadModuleExports(options: {
  modulePaths: readonly string[]
  projectRoot: string
  kind:
    | "action"
    | "agent"
    | "ontology"
    | "dataset"
    | "function"
    | "connector"
    | "sync"
    | "projection"
    | "schedule"
    | "pipeline"
    | "rule"
    | "trigger"
    | "group"
    | "role"
    | "membershipPolicy"
    | "workflow"
    | "share"
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
