import { INSTANCE_COMMANDS, type InstanceCommand } from "@sixb/cli-core"

type OptionKind = "boolean" | "string"

export const CLI_OPTION_DEFINITIONS = {
  entry: {
    syntax: "--entry <path>",
    summary: "Entry file (default: sixb.config.ts)",
    kind: "string",
  },
  "no-migrate": {
    syntax: "--no-migrate",
    summary: "Start a role without migrating storage (or SIXB_SKIP_MIGRATION=1)",
    kind: "boolean",
  },
  port: { syntax: "--port <port>", summary: "Role port; dev uses Atlas base port", kind: "string" },
  host: {
    syntax: "--host <host>",
    summary: "Bind host (dev: 127.0.0.1, production roles: 0.0.0.0)",
    kind: "string",
  },
  "api-port": {
    syntax: "--api-port <port>",
    summary: "API port (default: Atlas port + 2)",
    kind: "string",
  },
  "api-host": {
    syntax: "--api-host <host>",
    summary: "API bind host (default: --host)",
    kind: "string",
  },
  "api-public-origin": {
    syntax: "--api-public-origin <origin>",
    summary: "Public API origin",
    kind: "string",
  },
  "agent-turn-timeout": {
    syntax: "--agent-turn-timeout <duration>",
    summary: "Agent turn wall-clock budget (default: 10m)",
    kind: "string",
  },
  concurrency: {
    syntax: "--concurrency <value>",
    summary: "Concurrent jobs: count for worker; repeat type=count for dev/worker-group",
    kind: "string",
  },
  "atlas-public-origin": {
    syntax: "--atlas-public-origin <origin>",
    summary: "Public Atlas origin",
    kind: "string",
  },
  "app-public-origin": {
    syntax: "--app-public-origin <origin>",
    summary: "Public custom app origin",
    kind: "string",
  },
  profile: { syntax: "--profile <name>", summary: "Use a saved API profile", kind: "string" },
  "api-url": {
    syntax: "--api-url <url>",
    summary: "Use an API without a saved profile",
    kind: "string",
  },
  token: {
    syntax: "--token <token>",
    summary: "Bearer token for an explicit API URL",
    kind: "string",
  },
  "token-stdin": {
    syntax: "--token-stdin",
    summary: "Import a login token from standard input",
    kind: "boolean",
  },
  id: { syntax: "--id <id>", summary: "Token or service-account id", kind: "string" },
  name: { syntax: "--name <name>", summary: "Token or service-account name", kind: "string" },
  description: {
    syntax: "--description <text>",
    summary: "Service-account description",
    kind: "string",
  },
  "expires-in": {
    syntax: "--expires-in <duration>",
    summary: "Token lifetime, e.g. 30d or 1y",
    kind: "string",
  },
  "expires-at": {
    syntax: "--expires-at <iso>",
    summary: "Token expiration timestamp",
    kind: "string",
  },
  group: { syntax: "--group <id>", summary: "Assignable token group; may repeat", kind: "string" },
  json: { syntax: "--json", summary: "Print JSON for management commands", kind: "boolean" },
  outdir: { syntax: "--outdir <path>", summary: "Build output directory", kind: "string" },
  "dry-run": {
    syntax: "--dry-run",
    summary: "Preview lake cleanup without changing storage",
    kind: "boolean",
  },
  "expire-older-than": {
    syntax: "--expire-older-than <interval>",
    summary: "Lake snapshot expiration window",
    kind: "string",
  },
  "delete-older-than": {
    syntax: "--delete-older-than <interval>",
    summary: "Lake file deletion window",
    kind: "string",
  },
} as const satisfies Record<string, { syntax: string; summary: string; kind: OptionKind }>

export type CliOptionName = keyof typeof CLI_OPTION_DEFINITIONS
export type LocalCommandId =
  | "dev"
  | "api"
  | "atlas"
  | "app"
  | "login"
  | "logout"
  | "status"
  | "profile:list"
  | "profile:show"
  | "profile:use"
  | "token:list"
  | "token:create"
  | "token:revoke"
  | "service-account:list"
  | "service-account:create"
  | "service-account:disable"
  | "service-account:token:list"
  | "service-account:token:create"
  | "service-account:token:revoke"
  | "scheduler"
  | "orchestrator"
  | "rules"
  | "worker"
  | "worker-group"
  | "check"
  | "typegen"
  | "build"
  | "db:migrate"
  | "lake:check"
  | "lake:cleanup"
  | "init"

interface CommandNode {
  readonly name: string
  readonly summary: string
  readonly usage: string
  readonly id?: LocalCommandId
  readonly instance?: boolean
  readonly children?: readonly CommandNode[]
  readonly options?: readonly CliOptionName[]
  readonly repeatable?: readonly CliOptionName[]
  readonly minimumPositionals?: number
  readonly maximumPositionals?: number
  readonly requiredInputs?: readonly {
    readonly option: CliOptionName
    readonly positional: number
  }[]
  readonly rootHelpLabel?: string
}

const CONNECTION_OPTIONS = ["api-url", "token", "profile"] as const
const TOKEN_CREATE_OPTIONS = [
  ...CONNECTION_OPTIONS,
  "name",
  "expires-at",
  "expires-in",
  "group",
  "json",
] as const
const SERVICE_ACCOUNT_CREATE_OPTIONS = [
  ...CONNECTION_OPTIONS,
  "id",
  "name",
  "description",
  "expires-at",
  "expires-in",
  "group",
  "json",
] as const

const INSTANCE_SUMMARIES = {
  project: "Show project metadata",
  ontology: "Inspect the visible ontology",
  objects: "Inspect, list, search, and query objects",
  telemetry: "Read current and historical telemetry",
  actions: "Discover and request actions",
  "action-runs": "Inspect action execution history",
  files: "Upload and download files",
  workflows: "Discover and start workflows",
  "workflow-runs": "Inspect workflow execution history",
} as const satisfies Record<InstanceCommand, string>

const instanceNodes: readonly CommandNode[] = INSTANCE_COMMANDS.map((name) => ({
  name,
  summary: INSTANCE_SUMMARIES[name],
  usage: `sixb ${name} --help`,
  instance: true,
  rootHelpLabel:
    name === "project" ? "project show" : name === "ontology" ? "ontology list|get" : `${name} ...`,
}))

const commandTree: readonly CommandNode[] = [
  command("dev", "Start local development (server + built-in UI + app)", {
    options: [
      "entry",
      "port",
      "host",
      "api-port",
      "api-host",
      "api-public-origin",
      "agent-turn-timeout",
      "concurrency",
      "atlas-public-origin",
      "app-public-origin",
    ],
    repeatable: ["concurrency"],
  }),
  command("api", "Start production API/docs/WebSocket server", {
    options: [
      "entry",
      "no-migrate",
      "port",
      "host",
      "api-port",
      "api-host",
      "api-public-origin",
      "atlas-public-origin",
      "app-public-origin",
    ],
  }),
  command("atlas", "Start production Atlas UI server", {
    options: ["entry", "port", "host", "api-public-origin", "atlas-public-origin"],
  }),
  command("app", "Start production custom app server", {
    options: ["entry", "port", "host", "api-public-origin", "app-public-origin"],
  }),
  command("login", "Save and select a local API profile", {
    usage: "sixb login <api-url> [--profile <name>] [--token-stdin]",
    options: ["profile", "token-stdin", "json"],
    minimumPositionals: 1,
    maximumPositionals: 1,
    rootHelpLabel: "login <api-url>",
  }),
  command("logout", "Remove a saved profile", { options: ["profile", "json"] }),
  command("status", "Check the selected API profile", {
    options: [...CONNECTION_OPTIONS, "json"],
  }),
  {
    name: "profile",
    summary: "Manage local API profiles",
    usage: "sixb profile <list|show|use> [name]",
    rootHelpLabel: "profile list|show|use",
    children: [
      command("profile:list", "List saved profiles", {
        path: ["profile", "list"],
        options: ["json"],
      }),
      command("profile:show", "Show a profile without exposing its token", {
        path: ["profile", "show"],
        usage: "sixb profile show [name]",
        options: ["json"],
        maximumPositionals: 1,
      }),
      command("profile:use", "Select the current profile", {
        path: ["profile", "use"],
        usage: "sixb profile use <name>",
        options: ["json"],
        minimumPositionals: 1,
        maximumPositionals: 1,
      }),
    ],
  },
  ...instanceNodes,
  {
    name: "token",
    summary: "Manage personal access tokens",
    usage: "sixb token <list|create|revoke>",
    children: [
      command("token:list", "List personal access tokens", {
        path: ["token", "list"],
        options: [...CONNECTION_OPTIONS, "json"],
        rootHelpLabel: "token list",
      }),
      command("token:create", "Create a personal access token", {
        path: ["token", "create"],
        usage: "sixb token create [name] [options]",
        options: TOKEN_CREATE_OPTIONS,
        repeatable: ["group"],
        maximumPositionals: 1,
        requiredInputs: [{ option: "name", positional: 0 }],
        rootHelpLabel: "token create",
      }),
      command("token:revoke", "Revoke a personal access token", {
        path: ["token", "revoke"],
        usage: "sixb token revoke <token-id>",
        options: [...CONNECTION_OPTIONS, "id", "json"],
        maximumPositionals: 1,
        requiredInputs: [{ option: "id", positional: 0 }],
        rootHelpLabel: "token revoke <id>",
      }),
    ],
  },
  {
    name: "service-account",
    summary: "Manage service accounts",
    usage: "sixb service-account <list|create|disable|token>",
    children: [
      command("service-account:list", "List service accounts", {
        path: ["service-account", "list"],
        options: [...CONNECTION_OPTIONS, "json"],
        rootHelpLabel: "service-account list",
      }),
      command("service-account:create", "Create a service account", {
        path: ["service-account", "create"],
        usage: "sixb service-account create [name] [options]",
        options: SERVICE_ACCOUNT_CREATE_OPTIONS,
        repeatable: ["group"],
        maximumPositionals: 1,
        requiredInputs: [{ option: "name", positional: 0 }],
        rootHelpLabel: "service-account create",
      }),
      command("service-account:disable", "Disable a service account", {
        path: ["service-account", "disable"],
        usage: "sixb service-account disable <service-account-id>",
        options: [...CONNECTION_OPTIONS, "id", "json"],
        maximumPositionals: 1,
        requiredInputs: [{ option: "id", positional: 0 }],
        rootHelpLabel: "service-account disable",
      }),
      {
        name: "token",
        summary: "Manage service-account tokens",
        usage: "sixb service-account token <list|create|revoke> <service-account-id>",
        rootHelpLabel: "service-account token",
        children: [
          command("service-account:token:list", "List service-account tokens", {
            path: ["service-account", "token", "list"],
            usage: "sixb service-account token list <service-account-id>",
            options: [...CONNECTION_OPTIONS, "json"],
            minimumPositionals: 1,
            maximumPositionals: 1,
          }),
          command("service-account:token:create", "Create a service-account token", {
            path: ["service-account", "token", "create"],
            usage: "sixb service-account token create <service-account-id> [name] [options]",
            options: [...CONNECTION_OPTIONS, "name", "expires-at", "expires-in", "group", "json"],
            repeatable: ["group"],
            minimumPositionals: 1,
            maximumPositionals: 2,
            requiredInputs: [{ option: "name", positional: 1 }],
          }),
          command("service-account:token:revoke", "Revoke a service-account token", {
            path: ["service-account", "token", "revoke"],
            usage: "sixb service-account token revoke <service-account-id> <token-id>",
            options: [...CONNECTION_OPTIONS, "id", "json"],
            minimumPositionals: 1,
            maximumPositionals: 2,
            requiredInputs: [{ option: "id", positional: 1 }],
          }),
        ],
      },
    ],
  },
  command("scheduler", "Start production scheduler event producer", {
    options: ["entry", "no-migrate"],
  }),
  command("orchestrator", "Start production event-to-queue dispatcher", {
    options: ["entry", "no-migrate"],
  }),
  command("rules", "Start production rules runtime", { options: ["entry", "no-migrate"] }),
  command(
    "worker",
    "Start production queue worker: sync, action, agent, pipeline, projection, workflow",
    {
      usage: "sixb worker <sync|action|agent|pipeline|projection|workflow> [options]",
      options: ["entry", "no-migrate", "api-public-origin", "agent-turn-timeout", "concurrency"],
      minimumPositionals: 1,
      maximumPositionals: 1,
      rootHelpLabel: "worker <type>",
    }
  ),
  command("worker-group", "Co-host multiple queue workers in one process (constrained resources)", {
    usage: "sixb worker-group [types...] [options]",
    options: ["entry", "no-migrate", "api-public-origin", "agent-turn-timeout", "concurrency"],
    repeatable: ["concurrency"],
    maximumPositionals: Number.POSITIVE_INFINITY,
    rootHelpLabel: "worker-group [types...]",
  }),
  command("check", "Validate project configuration and health", { options: ["entry"] }),
  command("typegen", "Generate ontology types for client query inference", { options: ["entry"] }),
  command("build", "Build runtime and production UI/app assets", { options: ["entry", "outdir"] }),
  {
    name: "db",
    summary: "Manage runtime storage",
    usage: "sixb db <migrate>",
    children: [
      command("db:migrate", "Run adapter-owned database migrations ahead of a role", {
        path: ["db", "migrate"],
        options: ["entry"],
        rootHelpLabel: "db migrate",
      }),
    ],
  },
  {
    name: "lake",
    summary: "Inspect and maintain lake storage",
    usage: "sixb lake <check|cleanup>",
    children: [
      command("lake:check", "Check lake dataset definitions for drift", {
        path: ["lake", "check"],
        options: ["entry"],
        rootHelpLabel: "lake check",
      }),
      command("lake:cleanup", "Run lake storage maintenance cleanup", {
        path: ["lake", "cleanup"],
        options: ["entry", "dry-run", "expire-older-than", "delete-older-than"],
        rootHelpLabel: "lake cleanup",
      }),
    ],
  },
  command("init", "Initialize sixb project in a directory", {
    usage: "sixb init [dir]",
    maximumPositionals: 1,
    rootHelpLabel: "init [dir]",
  }),
]

export interface CliHelpItem {
  readonly label: string
  readonly value: string
}

export interface CliHelp {
  readonly path: readonly string[]
  readonly usage: string
  readonly summary: string
  readonly commands: readonly CliHelpItem[]
  readonly options: readonly CliHelpItem[]
}

export interface ParsedCliOptions {
  readonly [name: string]: string | boolean | readonly string[] | undefined
}

export type ParsedCli =
  | { readonly kind: "help"; readonly help: CliHelp }
  | { readonly kind: "version" }
  | { readonly kind: "instance"; readonly args: readonly string[] }
  | {
      readonly kind: "command"
      readonly id: LocalCommandId
      readonly path: readonly string[]
      readonly positionals: readonly string[]
      readonly options: ParsedCliOptions
    }

export class CliUsageError extends Error {
  readonly help: CliHelp
  readonly exitCode = 2

  constructor(message: string, help: CliHelp) {
    super(message)
    this.name = "CliUsageError"
    this.help = help
  }
}

export const ROOT_HELP: CliHelp = {
  path: [],
  usage: "sixb <command> [options]",
  summary: "Real-time digital twin framework",
  commands: rootHelpItems(commandTree),
  options: [
    ...Object.values(CLI_OPTION_DEFINITIONS).map(({ syntax, summary }) => ({
      label: syntax,
      value: summary,
    })),
    { label: "--help", value: "Show contextual help" },
    { label: "--version", value: "Show version" },
  ],
}

export const CLI_EXAMPLES = [
  "sixb dev",
  "sixb build",
  "sixb api",
  "sixb login http://localhost:3002 --profile local",
  "sixb ontology list",
  "sixb objects inspect Customer customer-123",
  "sixb token create --name 'Local CLI' --expires-in 90d",
  "sixb service-account create --id svc_sandbox --name 'Sandbox agent' --group agents",
  "sixb service-account token create svc_sandbox --name 'Sandbox token' --expires-in 30d",
  "sixb status",
  "sixb atlas",
  "sixb app",
  "sixb scheduler",
  "sixb orchestrator",
  "sixb rules",
  "sixb worker pipeline",
  "sixb worker agent --concurrency 8",
  "sixb worker-group sync agent --concurrency sync=2 --concurrency agent=8",
  "sixb dev --entry examples/mac-os/sixb.config.ts --port 8080",
  "sixb check",
  "sixb typegen",
  "sixb db migrate",
  "sixb lake check",
  "sixb lake cleanup --dry-run",
] as const

export function parseCliArgs(args: readonly string[]): ParsedCli {
  const first = args[0]
  if (!first) return { kind: "help", help: ROOT_HELP }
  if (first === "--help" || first === "-h") {
    if (args.length !== 1) throw new CliUsageError(`${first} accepts no arguments.`, ROOT_HELP)
    return { kind: "help", help: ROOT_HELP }
  }
  if (first === "--version" || first === "-v") {
    if (args.length !== 1) throw new CliUsageError("--version accepts no arguments.", ROOT_HELP)
    return { kind: "version" }
  }
  if (first === "help") return parseHelpArgs(args.slice(1))
  if (first.startsWith("-")) throw new CliUsageError(`Unknown option '${first}'.`, ROOT_HELP)

  const root = commandTree.find((node) => node.name === first)
  if (!root) throw new CliUsageError(`Unknown command '${first}'.`, ROOT_HELP)
  if (root.instance) return { kind: "instance", args }
  return parseLocalCommand(root, args)
}

export function stringOption(options: ParsedCliOptions, name: CliOptionName): string | undefined {
  const value = options[name]
  return typeof value === "string" ? value : undefined
}

export function booleanOption(options: ParsedCliOptions, name: CliOptionName): boolean {
  return options[name] === true
}

export function repeatedOption(options: ParsedCliOptions, name: CliOptionName): readonly string[] {
  const value = options[name]
  return Array.isArray(value) ? value : typeof value === "string" ? [value] : []
}

export function wantsManagementJson(args: readonly string[]): boolean {
  return (
    ["login", "logout", "status", "profile", "token", "service-account"].includes(args[0] ?? "") &&
    args.some((argument) => argument === "--json" || argument.startsWith("--json="))
  )
}

function command(
  id: LocalCommandId,
  summary: string,
  input: {
    readonly path?: readonly string[]
    readonly usage?: string
    readonly options?: readonly CliOptionName[]
    readonly repeatable?: readonly CliOptionName[]
    readonly minimumPositionals?: number
    readonly maximumPositionals?: number
    readonly requiredInputs?: readonly {
      readonly option: CliOptionName
      readonly positional: number
    }[]
    readonly rootHelpLabel?: string
  } = {}
): CommandNode {
  const path = input.path ?? [id]
  return {
    name: path.at(-1) ?? id,
    id,
    summary,
    usage: input.usage ?? `sixb ${path.join(" ")}`,
    options: input.options,
    repeatable: input.repeatable,
    minimumPositionals: input.minimumPositionals,
    maximumPositionals: input.maximumPositionals ?? 0,
    requiredInputs: input.requiredInputs,
    rootHelpLabel: input.rootHelpLabel ?? (path.length === 1 ? path[0] : undefined),
  }
}

function parseHelpArgs(path: readonly string[]): ParsedCli {
  if (path.length === 0) return { kind: "help", help: ROOT_HELP }
  const root = commandTree.find((node) => node.name === path[0])
  if (!root) throw new CliUsageError(`Unknown command '${path[0]}'.`, ROOT_HELP)
  if (root.instance) return { kind: "instance", args: [...path, "--help"] }

  let node = root
  for (const name of path.slice(1)) {
    const child = node.children?.find((candidate) => candidate.name === name)
    if (!child) throw new CliUsageError(`Unknown command '${path.join(" ")}'.`, helpFor(node, path))
    node = child
  }
  return { kind: "help", help: helpFor(node, path) }
}

function parseLocalCommand(root: CommandNode, args: readonly string[]): ParsedCli {
  let node = root
  let index = 1
  const path = [root.name]

  while (node.children) {
    const next = args[index]
    if (!next || next === "--help" || next === "-h") {
      return { kind: "help", help: helpFor(node, path) }
    }
    if (next.startsWith("-")) {
      throw new CliUsageError(`'${path.join(" ")}' requires a subcommand.`, helpFor(node, path))
    }
    const child = node.children.find((candidate) => candidate.name === next)
    if (!child) {
      throw new CliUsageError(`Unknown ${path.join(" ")} command '${next}'.`, helpFor(node, path))
    }
    node = child
    path.push(next)
    index++
  }

  if (!node.id) throw new Error(`[SixbCLI] Command '${path.join(" ")}' has no handler.`)
  const remaining = args.slice(index)
  if (requestsHelp(remaining)) {
    return { kind: "help", help: helpFor(node, path) }
  }
  const { options, positionals } = parseOptions(node, path, remaining)
  return { kind: "command", id: node.id, path, positionals, options }
}

function requestsHelp(args: readonly string[]): boolean {
  const separator = args.indexOf("--")
  const options = separator < 0 ? args : args.slice(0, separator)
  return options.includes("--help") || options.includes("-h")
}

function parseOptions(
  node: CommandNode,
  path: readonly string[],
  args: readonly string[]
): { readonly options: ParsedCliOptions; readonly positionals: readonly string[] } {
  const options: Record<string, string | boolean | string[]> = {}
  const positionals: string[] = []
  const allowed = new Set(node.options ?? [])
  const repeatable = new Set(node.repeatable ?? [])
  let positionalOnly = false

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === undefined) continue
    if (argument === "--") {
      positionalOnly = true
      continue
    }
    if (positionalOnly || !argument.startsWith("-")) {
      positionals.push(argument)
      continue
    }
    if (!argument.startsWith("--")) {
      throw new CliUsageError(`Unknown option '${argument}'.`, helpFor(node, path))
    }

    const equalsIndex = argument.indexOf("=")
    const name = argument.slice(2, equalsIndex < 0 ? undefined : equalsIndex) as CliOptionName
    const definition = CLI_OPTION_DEFINITIONS[name]
    if (!definition || !allowed.has(name)) {
      throw new CliUsageError(
        `Unknown option '--${name}' for '${path.join(" ")}'.`,
        helpFor(node, path)
      )
    }
    if (options[name] !== undefined && !repeatable.has(name)) {
      throw new CliUsageError(`--${name} may only be provided once.`, helpFor(node, path))
    }

    if (definition.kind === "boolean") {
      if (equalsIndex >= 0) {
        throw new CliUsageError(`--${name} does not accept a value.`, helpFor(node, path))
      }
      options[name] = true
      continue
    }

    const value = equalsIndex < 0 ? args[++index] : argument.slice(equalsIndex + 1)
    if (!value || value.startsWith("--")) {
      throw new CliUsageError(`--${name} requires a value.`, helpFor(node, path))
    }
    if (repeatable.has(name)) {
      const values = options[name]
      options[name] = Array.isArray(values) ? [...values, value] : [value]
    } else {
      options[name] = value
    }
  }

  const minimum = node.minimumPositionals ?? 0
  const maximum = node.maximumPositionals ?? 0
  if (positionals.length < minimum || positionals.length > maximum) {
    throw new CliUsageError(`Invalid arguments for '${path.join(" ")}'.`, helpFor(node, path))
  }
  for (const required of node.requiredInputs ?? []) {
    if (!positionals[required.positional] && typeof options[required.option] !== "string") {
      throw new CliUsageError(
        `Missing required ${CLI_OPTION_DEFINITIONS[required.option].syntax}.`,
        helpFor(node, path)
      )
    }
  }
  if (typeof options["api-url"] === "string" && typeof options.profile === "string") {
    throw new CliUsageError("--api-url and --profile cannot be used together.", helpFor(node, path))
  }
  return { options, positionals }
}

function helpFor(node: CommandNode, path: readonly string[]): CliHelp {
  const prefix = `sixb ${path.join(" ")}`
  return {
    path: [...path],
    usage: node.usage,
    summary: node.summary,
    commands: (node.children ?? []).map((child) => ({
      label: child.usage.startsWith(`${prefix} `)
        ? child.usage.slice(prefix.length + 1)
        : child.name,
      value: child.summary,
    })),
    options: [
      ...(node.options ?? []).map((name) => ({
        label: CLI_OPTION_DEFINITIONS[name].syntax,
        value: CLI_OPTION_DEFINITIONS[name].summary,
      })),
      { label: "--help", value: "Show this help" },
    ],
  }
}

function rootHelpItems(nodes: readonly CommandNode[]): CliHelpItem[] {
  const items: CliHelpItem[] = []
  for (const node of nodes) {
    if (node.rootHelpLabel) items.push({ label: node.rootHelpLabel, value: node.summary })
    if (!node.rootHelpLabel && node.children) items.push(...rootHelpItems(node.children))
  }
  return items
}
