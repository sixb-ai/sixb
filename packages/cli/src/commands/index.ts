import type { ApiClient } from "../api-client"
import { fail } from "../output"
import { actions } from "./actions"
import { apiCommand } from "./api"
import { artifacts } from "./artifacts"
import { datasets, runnables } from "./data"
import { files } from "./files"
import { memory } from "./memory"
import { models } from "./models"
import { objects } from "./objects"
import { activity, connectors, logs } from "./observability"
import { ontology } from "./ontology"
import { project } from "./project"
import { runs } from "./runs"
import { serviceAccounts } from "./service-accounts"
import { shares } from "./shares"
import { status } from "./status"
import { telemetry } from "./telemetry"
import { threads } from "./threads"
import { tokens } from "./tokens"
import { users } from "./users"
import { workflows } from "./workflows"

export type CommandCategory =
  | "Discovery"
  | "Objects"
  | "Telemetry"
  | "Actions and workflows"
  | "Data"
  | "Files"
  | "Members and access"
  | "Threads and memory"
  | "Artifacts and models"
  | "Observability"
  | "Raw API"

export interface CommandEntry {
  readonly name: InstanceCommand
  readonly category: CommandCategory
  readonly summary: string
  readonly run: (api: ApiClient, args: readonly string[]) => Promise<void>
}

export const INSTANCE_COMMANDS = [
  "status",
  "project",
  "ontology",
  "objects",
  "telemetry",
  "actions",
  "action-runs",
  "files",
  "workflows",
  "workflow-runs",
  "users",
  "tokens",
  "service-accounts",
  "shares",
  "artifacts",
  "models",
  "datasets",
  "syncs",
  "sync-runs",
  "pipelines",
  "pipeline-runs",
  "threads",
  "memory",
  "logs",
  "activity",
  "connectors",
  "api",
] as const

export type InstanceCommand = (typeof INSTANCE_COMMANDS)[number]

/** Single declarative registry for every API command group. */
export const COMMAND_REGISTRY: readonly CommandEntry[] = [
  {
    name: "status",
    category: "Discovery",
    summary: "Check API connection, project, and runtime",
    run: status,
  },
  { name: "project", category: "Discovery", summary: "Show project metadata", run: project },
  {
    name: "ontology",
    category: "Discovery",
    summary: "Inspect the visible ontology",
    run: ontology,
  },
  {
    name: "objects",
    category: "Objects",
    summary: "Inspect, list, search, and query objects",
    run: objects,
  },
  {
    name: "telemetry",
    category: "Telemetry",
    summary: "Read current and historical telemetry",
    run: telemetry,
  },
  {
    name: "actions",
    category: "Actions and workflows",
    summary: "Discover and request actions",
    run: actions,
  },
  {
    name: "action-runs",
    category: "Actions and workflows",
    summary: "Inspect action execution history",
    run: (api, args) => runs(api, "action", args),
  },
  {
    name: "workflows",
    category: "Actions and workflows",
    summary: "Discover and start workflows",
    run: workflows,
  },
  {
    name: "workflow-runs",
    category: "Actions and workflows",
    summary: "Inspect and cancel workflow runs",
    run: (api, args) => runs(api, "workflow", args),
  },
  {
    name: "datasets",
    category: "Data",
    summary: "Read datasets, versions, and rows",
    run: datasets,
  },
  {
    name: "syncs",
    category: "Data",
    summary: "List, inspect, and run syncs",
    run: (api, args) => runnables(api, "syncs", args),
  },
  {
    name: "sync-runs",
    category: "Data",
    summary: "Inspect sync run history",
    run: (api, args) => runs(api, "sync", args),
  },
  {
    name: "pipelines",
    category: "Data",
    summary: "List, inspect, and run pipelines",
    run: (api, args) => runnables(api, "pipelines", args),
  },
  {
    name: "pipeline-runs",
    category: "Data",
    summary: "Inspect pipeline runs and their steps",
    run: (api, args) => runs(api, "pipeline", args),
  },
  { name: "files", category: "Files", summary: "Upload and download files", run: files },
  {
    name: "users",
    category: "Members and access",
    summary: "List and search project members",
    run: users,
  },
  {
    name: "tokens",
    category: "Members and access",
    summary: "Manage personal access tokens",
    run: tokens,
  },
  {
    name: "service-accounts",
    category: "Members and access",
    summary: "Manage service accounts and their tokens",
    run: serviceAccounts,
  },
  {
    name: "shares",
    category: "Members and access",
    summary: "List, create, and revoke shared-access grants",
    run: shares,
  },
  {
    name: "threads",
    category: "Threads and memory",
    summary: "List threads, messages, runs, and approvals",
    run: threads,
  },
  {
    name: "memory",
    category: "Threads and memory",
    summary: "Read, pull, and save memory repos",
    run: memory,
  },
  {
    name: "artifacts",
    category: "Artifacts and models",
    summary: "Manage artifacts, comments, media, and video exports",
    run: artifacts,
  },
  {
    name: "models",
    category: "Artifacts and models",
    summary: "List and call the project's AI models",
    run: models,
  },
  { name: "logs", category: "Observability", summary: "Read project logs", run: logs },
  { name: "activity", category: "Observability", summary: "Read activity metrics", run: activity },
  {
    name: "connectors",
    category: "Observability",
    summary: "Inspect connector accounts",
    run: connectors,
  },
  {
    name: "api",
    category: "Raw API",
    summary: "Send an authenticated request to any relative /api/ path",
    run: apiCommand,
  },
] as const

const COMMAND_BY_NAME = new Map<string, CommandEntry>(
  COMMAND_REGISTRY.map((entry) => [entry.name, entry])
)

export function isInstanceCommand(command: string): command is InstanceCommand {
  return COMMAND_BY_NAME.has(command)
}

export async function dispatch(
  api: ApiClient,
  command: string,
  args: readonly string[]
): Promise<void> {
  const entry = COMMAND_BY_NAME.get(command)
  if (!entry) fail(`Unknown command '${command}'. Run 'sixb --help'.`)
  return entry.run(api, args)
}
