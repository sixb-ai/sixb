// Interpret the single `bash` tool into a human-friendly view. Sixb interactions go through a
// stable CLI command tree, so the UI only needs to tokenize one command and identify its group and
// operation. Plain shell commands and the initial skill read keep neutral fallbacks.

import { commandInvocation, executableName, lexShellCommand, type ShellSegment } from "./shell"

/** The bash tool input as authored by the agent. */
export interface BashInput {
  readonly command: string
  readonly cwd?: string
  readonly timeoutMs?: number
}

const CLI_COMMANDS = {
  project: ["show"],
  ontology: ["list", "get"],
  objects: ["inspect", "list", "get", "search", "query", "count", "exists", "facets", "links"],
  telemetry: ["latest", "history", "query"],
  actions: ["list", "get", "request"],
  "action-runs": ["list", "get"],
  files: ["upload", "download"],
  workflows: ["list", "get", "start"],
  "workflow-runs": ["list", "get"],
  api: ["get", "post"],
} as const

type CliGroup = keyof typeof CLI_COMMANDS
type CliCommandName = {
  [Group in CliGroup]: `${Group}.${(typeof CLI_COMMANDS)[Group][number]}`
}[CliGroup]

type SixbCommandName =
  | "help"
  | "version"
  | "doctor"
  | "context"
  | "objects.query-example"
  | CliCommandName
  | "unknown"

type AtomicBashIntent =
  | {
      readonly kind: "sixb"
      readonly command: SixbCommandName
      /** Arguments after the recognized command path. Quotes have been removed. */
      readonly args: readonly string[]
    }
  | { readonly kind: "read-skill"; readonly skillName?: string; readonly reference?: string }
  | { readonly kind: "generic"; readonly command: string }

/** What the agent was trying to do, derived from the command string. */
export type BashIntent =
  | AtomicBashIntent
  | {
      readonly kind: "compound"
      /** The most meaningful segment, used only to present this work in product language. */
      readonly primary: AtomicBashIntent
      readonly stepCount: number
    }

/** Parsed bash output, with stdout JSON-decoded when it looks like JSON. */
export interface ParsedBashOutput {
  readonly ok: boolean
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly truncated: boolean
  /** Decoded stdout when it parsed as JSON, otherwise undefined. */
  readonly json: unknown
}

// --- Input/output coercion -------------------------------------------------

export function coerceBashInput(input: unknown): BashInput | null {
  if (!isRecord(input) || typeof input.command !== "string") return null
  return {
    command: input.command,
    cwd: typeof input.cwd === "string" ? input.cwd : undefined,
    timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
  }
}

export function coerceBashOutput(output: unknown): ParsedBashOutput | null {
  if (!isRecord(output)) return null
  const stdout = typeof output.stdout === "string" ? output.stdout : ""
  const stderr = typeof output.stderr === "string" ? output.stderr : ""
  const exitCode = typeof output.exitCode === "number" ? output.exitCode : 0
  return {
    ok: exitCode === 0,
    exitCode,
    stdout,
    stderr,
    durationMs: typeof output.durationMs === "number" ? output.durationMs : 0,
    truncated: output.stdoutTruncated === true || output.stderrTruncated === true,
    json: exitCode === 0 ? tryParseJson(stdout) : undefined,
  }
}

// --- Command classification ------------------------------------------------

export function classifyCommand(command: string): BashIntent {
  const segments = lexShellCommand(command)
  if (!segments) return { kind: "generic", command: command.trim() }
  if (segments.length > 1) {
    return {
      kind: "compound",
      primary: selectCompoundPrimary(segments),
      stepCount: segments.length,
    }
  }
  return classifyAtomicCommand(segments[0])
}

function classifyAtomicCommand(segment: ShellSegment | undefined): AtomicBashIntent {
  if (!segment) return { kind: "generic", command: "" }
  const invocation = commandInvocation(segment.tokens)
  const sixb = classifySixbCommand(invocation)
  if (sixb) return sixb
  const skill = classifySkillRead(segment, invocation)
  if (skill) return skill
  return { kind: "generic", command: segment.command }
}

function selectCompoundPrimary(segments: readonly ShellSegment[]): AtomicBashIntent {
  const fallbackIndex = segments.findIndex((segment) => segment.operatorBefore === "||")
  const primaryBranch = fallbackIndex === -1 ? segments : segments.slice(0, fallbackIndex)
  const intents = primaryBranch.map((segment) => classifyAtomicCommand(segment))
  let selected = intents[0] ?? classifyAtomicCommand(segments[0])
  let selectedPriority = compoundIntentPriority(selected)

  for (const intent of intents.slice(1)) {
    const priority = compoundIntentPriority(intent)
    // Prefer the final operation when two segments are equally meaningful.
    if (priority >= selectedPriority) {
      selected = intent
      selectedPriority = priority
    }
  }
  return selected
}

function compoundIntentPriority(intent: AtomicBashIntent): number {
  if (intent.kind === "sixb" || intent.kind === "read-skill") return 3
  const category = genericCommandCategory(intent.command)
  if (category.kind === "unknown") return isShellPlumbing(intent.command) ? -1 : 0
  if (
    category.kind === "inspect-files" ||
    category.kind === "workspace-location" ||
    category.kind === "read-file"
  ) {
    return 1
  }
  return 2
}

function isShellPlumbing(command: string): boolean {
  const executable = directCommandExecutable(command)
  return Boolean(
    executable &&
      ["cd", "export", "set", "unset", "source", ".", "env", "jq", "true", "false"].includes(
        executable
      )
  )
}

function classifySixbCommand(
  tokens: readonly string[]
): Extract<BashIntent, { kind: "sixb" }> | null {
  if (executableName(tokens[0]) !== "sixb") return null

  const cliArgs = tokens.slice(1)
  if (cliArgs.length === 0 || isHelpToken(cliArgs[0])) {
    return { kind: "sixb", command: "help", args: [] }
  }
  if (isHelpToken(cliArgs[1])) return { kind: "sixb", command: "help", args: [cliArgs[0]] }
  if (isHelpToken(cliArgs[2])) {
    return { kind: "sixb", command: "help", args: cliArgs.slice(0, 2) }
  }
  if (cliArgs[0] === "version" || cliArgs[0] === "--version") {
    return { kind: "sixb", command: "version", args: cliArgs.slice(1) }
  }
  if (cliArgs[0] === "doctor" || cliArgs[0] === "context") {
    return { kind: "sixb", command: cliArgs[0], args: cliArgs.slice(1) }
  }

  const [group, operation, ...args] = cliArgs
  if (!group || !operation) {
    return { kind: "sixb", command: "help", args: group ? [group] : [] }
  }
  if (!isCliGroup(group) || !isCliOperation(group, operation)) {
    return { kind: "sixb", command: "unknown", args: cliArgs }
  }
  if (group === "objects" && operation === "query" && optionValue(args, "--example")) {
    return { kind: "sixb", command: "objects.query-example", args }
  }
  return { kind: "sixb", command: `${group}.${operation}` as CliCommandName, args }
}

function isHelpToken(value: string | undefined): boolean {
  return value === "--help" || value === "-h" || value === "help"
}

function isCliGroup(value: string): value is CliGroup {
  return Object.hasOwn(CLI_COMMANDS, value)
}

function isCliOperation<Group extends CliGroup>(
  group: Group,
  value: string
): value is (typeof CLI_COMMANDS)[Group][number] {
  return (CLI_COMMANDS[group] as readonly string[]).includes(value)
}

const SKILL_READ_COMMANDS = new Set(["cat", "less", "bat", "head", "tail", "sed", "nl"])

function classifySkillRead(
  segment: ShellSegment,
  invocation: readonly string[]
): Extract<AtomicBashIntent, { kind: "read-skill" }> | null {
  const looksLikeRead = SKILL_READ_COMMANDS.has(executableName(invocation[0]) ?? "")
  const command = segment.command
  const touchesSkill =
    command.includes("SKILL.md") ||
    command.includes("/skills/") ||
    command.includes("SIXB_SKILLS_DIR") ||
    command.includes("/references/")
  if (!looksLikeRead || !touchesSkill) return null

  const skillName = command.match(/(?:skills|SKILLS_DIR)\/([A-Za-z0-9._-]+)/)?.[1]
  const reference = command.match(/references\/([A-Za-z0-9._-]+)/)?.[1]
  return { kind: "read-skill", skillName, reference }
}

// --- Friendly description --------------------------------------------------

export type BashIcon =
  | "ontology"
  | "objects"
  | "object"
  | "count"
  | "facets"
  | "telemetry"
  | "actions"
  | "project"
  | "skill"
  | "terminal"

interface BashDescription {
  readonly icon: BashIcon
  /** Past-tense headline once the command has run, e.g. "Explored the ontology". */
  readonly title: string
  /** Present-progressive headline while running, e.g. "Exploring the ontology". */
  readonly runningTitle: string
  /** Optional secondary line derived from the result, e.g. "8 object types". */
  readonly detail?: string
}

export function describeBash(intent: BashIntent, parsed: ParsedBashOutput | null): BashDescription {
  if (intent.kind === "compound") {
    const primary = describeBash(intent.primary, parsed)
    if (primary.runningTitle !== "Running a command") return primary
    const steps = `${intent.stepCount.toLocaleString()} steps`
    return icon("terminal", `Ran ${steps}`, `Running ${steps}`)
  }
  if (intent.kind === "sixb") return describeSixb(intent, parsed)
  if (intent.kind === "read-skill") {
    const label = skillLabel(intent)
    return icon("skill", `Read the ${label}`, `Reading the ${label}`)
  }
  return describeGenericCommand(intent.command)
}

type GenericCommandCategory =
  | { readonly kind: "write-file"; readonly fileKind: string }
  | {
      readonly kind:
        | "edit-files"
        | "search-files"
        | "run-tests"
        | "create-folder"
        | "copy-files"
        | "move-files"
        | "inspect-files"
        | "workspace-location"
        | "read-file"
        | "unknown"
    }

function describeGenericCommand(command: string): BashDescription {
  const category = genericCommandCategory(command)
  switch (category.kind) {
    case "write-file":
      return icon("terminal", `Created ${category.fileKind}`, `Creating ${category.fileKind}`)
    case "edit-files":
      return icon("terminal", "Edited files", "Editing files")
    case "search-files":
      return icon("terminal", "Searched files", "Searching files")
    case "run-tests":
      return icon("terminal", "Ran tests", "Running tests")
    case "create-folder":
      return icon("terminal", "Created a folder", "Creating a folder")
    case "copy-files":
      return icon("terminal", "Copied files", "Copying files")
    case "move-files":
      return icon("terminal", "Moved files", "Moving files")
    case "inspect-files":
      return icon("terminal", "Inspected files", "Inspecting files")
    case "workspace-location":
      return icon("terminal", "Checked the workspace location", "Checking the workspace location")
    case "read-file":
      return icon("terminal", "Read a file", "Reading a file")
    default:
      return icon("terminal", "Ran a command", "Running a command")
  }
}

function genericCommandCategory(command: string): GenericCommandCategory {
  const firstLine = command.trim().split(/\r?\n/, 1)[0]?.trim() ?? ""
  const segment = directCommandSegment(command)
  const invocation = commandInvocation(segment?.tokens ?? [])
  const fileKind = writtenFileKind(command, firstLine, segment, invocation)
  if (fileKind) return { kind: "write-file", fileKind }
  const executable = executableName(invocation[0]) ?? leadingExecutable(firstLine)
  if (executable === "apply_patch") return { kind: "edit-files" }
  if (executable === "rg" || executable === "grep") return { kind: "search-files" }
  if (executable === "bun" && invocation[1] === "test") return { kind: "run-tests" }
  if (executable === "mkdir") return { kind: "create-folder" }
  if (executable === "cp") return { kind: "copy-files" }
  if (executable === "mv") return { kind: "move-files" }
  if (executable === "ls" || executable === "find") return { kind: "inspect-files" }
  if (executable === "pwd") return { kind: "workspace-location" }
  if (executable === "head" && headReadsFile(invocation)) return { kind: "read-file" }
  return { kind: "unknown" }
}

function headReadsFile(tokens: readonly string[]): boolean {
  return tokens.slice(1).some((token) => !token.startsWith("-") && !/^\d+$/.test(token))
}

function directCommandSegment(command: string): ShellSegment | undefined {
  const segments = lexShellCommand(command)
  return segments?.length === 1 ? segments[0] : undefined
}

function directCommandExecutable(command: string): string | undefined {
  const invocation = commandInvocation(directCommandSegment(command)?.tokens ?? [])
  return executableName(invocation[0])
}

function leadingExecutable(firstLine: string): string | undefined {
  const match = firstLine.match(/^\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+)\s+)*([^\s;&|<>]+)/)
  return executableName(match?.[1])
}

function writtenFileKind(
  command: string,
  firstLine: string,
  segment: ShellSegment | undefined,
  invocation: readonly string[]
): string | null {
  const executable = executableName(invocation[0]) ?? leadingExecutable(firstLine)
  if (!executable || !["cat", "tee", "printf", "echo"].includes(executable)) return null

  const directTarget = segment?.outputRedirects?.at(-1)
  const heredocTarget = command.includes("<<")
    ? firstLine.match(/(?:^|\s)>{1,2}\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/)
    : null
  const target = (
    directTarget ??
    heredocTarget?.[1] ??
    heredocTarget?.[2] ??
    heredocTarget?.[3] ??
    ""
  ).toLowerCase()
  if (!target) return null
  if (/<!doctype\s+html|<html(?:\s|>)/i.test(command) || /\.html?$/.test(target)) {
    return "an HTML file"
  }
  if (/\.json$/.test(target)) return "a JSON file"
  if (/\.(?:md|mdx)$/.test(target)) return "a Markdown file"
  if (/\.(?:csv|tsv)$/.test(target)) return "a data file"
  return "a file"
}

/** A stable one-line command preview. Multiline payloads stay folded behind the raw disclosure. */
export function commandPreview(command: string, max = 96): string {
  const lines = command.trim().split(/\r?\n/)
  const firstLine = truncateEnd(lines[0]?.trim() ?? "", max)
  if (lines.length <= 1) return firstLine
  const remaining = lines.length - 1
  return `${firstLine}\n… ${remaining.toLocaleString()} more ${remaining === 1 ? "line" : "lines"}`
}

function describeSixb(
  intent: Extract<BashIntent, { kind: "sixb" }>,
  parsed: ParsedBashOutput | null
): BashDescription {
  const type = commandObjectType(intent, parsed)
  switch (intent.command) {
    case "help": {
      const subject = helpSubject(intent.args)
      return icon("skill", `Checked ${subject}`, `Checking ${subject}`)
    }
    case "version":
      return icon("terminal", "Checked the Sixb version", "Checking the Sixb version")
    case "doctor":
      return icon("terminal", "Checked the agent runtime", "Checking the agent runtime")
    case "context":
      return icon("project", "Read the run context", "Reading the run context")
    case "ontology.list": {
      const n = arrayLength(parsed?.json)
      return icon(
        "ontology",
        "Explored the ontology",
        "Exploring the ontology",
        count(n, "object type")
      )
    }
    case "ontology.get":
      return icon(
        "ontology",
        `Inspected the ${humanize(intent.args[0]) || "object"} type`,
        `Inspecting the ${humanize(intent.args[0]) || "object"} type`
      )
    case "objects.inspect": {
      const objectId = intent.args[1] ?? "object"
      return icon(
        "object",
        `Inspected ${objectId}`,
        `Inspecting ${objectId}`,
        graphDetail(parsed?.json)
      )
    }
    case "objects.list":
    case "objects.get":
    case "objects.search":
    case "objects.query": {
      const n = objectCount(parsed?.json)
      const label = humanize(type) || "object"
      const title = n === null ? "Queried objects" : `Found ${count(n, label)}`
      return icon("objects", title, `Looking up ${plural(label)}`)
    }
    case "objects.query-example":
      return icon("skill", "Read a query example", "Reading a query example")
    case "objects.count": {
      const value = numberField(parsed?.json, "count")
      // Singular base — `plural()` adds the suffix, so "objects" here would become "objectses".
      const label = humanize(type) || "object"
      return icon(
        "count",
        `Counted ${plural(label)}`,
        `Counting ${plural(label)}`,
        value === null ? undefined : value.toLocaleString()
      )
    }
    case "objects.exists": {
      const value = boolField(parsed?.json, "exists")
      return icon(
        "count",
        "Checked for matches",
        "Checking for matches",
        value === null ? undefined : value ? "Yes" : "No"
      )
    }
    case "objects.facets":
      return icon("facets", "Broke down the data", "Breaking down the data")
    case "objects.links": {
      const n = nestedArrayLength(parsed?.json, "links")
      return icon(
        "objects",
        `Read links for ${intent.args[1] ?? "an object"}`,
        `Reading links for ${intent.args[1] ?? "an object"}`,
        count(n, "link")
      )
    }
    case "telemetry.latest":
      return icon(
        "telemetry",
        `Read latest ${humanize(intent.args[2]) || "telemetry"}`,
        `Reading latest ${humanize(intent.args[2]) || "telemetry"}`,
        latestReading(parsed?.json)
      )
    case "telemetry.history": {
      const n = arrayLength(parsed?.json)
      return icon(
        "telemetry",
        `Read ${humanize(intent.args[2]) || "telemetry"} history`,
        `Reading ${humanize(intent.args[2]) || "telemetry"} history`,
        count(n, "point")
      )
    }
    case "telemetry.query": {
      const n = seriesCount(parsed?.json)
      return icon(
        "telemetry",
        "Compared telemetry series",
        "Comparing telemetry series",
        n === null ? undefined : `${n} series`
      )
    }
    case "actions.list": {
      const n = arrayLength(parsed?.json)
      return icon(
        "actions",
        "Listed available actions",
        "Listing available actions",
        count(n, "action")
      )
    }
    case "actions.get":
      return icon(
        "actions",
        `Inspected the ${humanize(intent.args[0]) || "action"} action`,
        `Inspecting the ${humanize(intent.args[0]) || "action"} action`
      )
    case "actions.request":
      return icon(
        "actions",
        `Ran the ${humanize(intent.args[0]) || "requested"} action`,
        `Running the ${humanize(intent.args[0]) || "requested"} action`,
        actionOutcome(parsed?.json)
      )
    case "action-runs.get": {
      const run = actionRunInfo(parsed?.json)
      return icon("actions", actionRunTitle(run), "Checking the action run", run.subjectLabel)
    }
    case "action-runs.list": {
      const n = arrayLength(parsed?.json)
      return icon("actions", "Listed action runs", "Listing action runs", count(n, "run"))
    }
    case "workflows.list": {
      const n = arrayLength(parsed?.json)
      return icon("actions", "Listed workflows", "Listing workflows", count(n, "workflow"))
    }
    case "workflows.get":
      return icon(
        "actions",
        `Inspected the ${humanize(intent.args[0]) || "workflow"} workflow`,
        `Inspecting the ${humanize(intent.args[0]) || "workflow"} workflow`
      )
    case "workflows.start":
      return icon(
        "actions",
        `Started the ${humanize(intent.args[0]) || "requested"} workflow`,
        `Starting the ${humanize(intent.args[0]) || "requested"} workflow`,
        runOutcome(parsed?.json)
      )
    case "workflow-runs.list": {
      const n = arrayLength(parsed?.json)
      return icon("actions", "Listed workflow runs", "Listing workflow runs", count(n, "run"))
    }
    case "workflow-runs.get":
      return icon(
        "actions",
        "Checked a workflow run",
        "Checking a workflow run",
        runStatus(parsed?.json)
      )
    case "files.upload":
      return icon("object", "Uploaded a file", "Uploading a file", filePath(parsed?.json))
    case "files.download":
      return icon("object", "Downloaded a file", "Downloading a file", filePath(parsed?.json))
    case "project.show":
      return icon("project", "Read project info", "Reading project info")
    case "api.get":
    case "api.post":
      return icon("terminal", "Called the Sixb API", "Calling the Sixb API", intent.args[0])
    default:
      return icon(
        "terminal",
        "Ran a Sixb command",
        "Running a Sixb command",
        truncateMiddle(intent.args.join(" "), 64)
      )
  }
}

function helpSubject(args: readonly string[]): string {
  const group = args.find((value) => !value.startsWith("-"))
  switch (group) {
    case "objects":
      return "how to work with project data"
    case "ontology":
      return "the project data model"
    case "telemetry":
      return "how to work with telemetry"
    case "actions":
      return "available actions"
    case "workflows":
      return "available workflows"
    case "files":
      return "how to work with files"
    case "project":
      return "project information"
    default:
      return "available project operations"
  }
}

function skillLabel(intent: Extract<BashIntent, { kind: "read-skill" }>): string {
  if (intent.reference) return `${referenceTitle(intent.reference)} reference`
  if (intent.skillName) return `${humanize(intent.skillName.replace(/^sixb-/, ""))} guide`
  return "skill guide"
}

function referenceTitle(reference: string): string {
  return humanize(reference.replace(/\.md$/, "").replace(/-/g, " "))
}

// --- Small helpers ---------------------------------------------------------

function icon(
  iconName: BashIcon,
  title: string,
  runningTitle: string,
  detail?: string
): BashDescription {
  return { icon: iconName, title, runningTitle, detail }
}

function count(n: number | null, noun: string): string | undefined {
  if (n === null) return undefined
  return n === 1 ? `1 ${noun}` : `${n.toLocaleString()} ${plural(noun)}`
}

function plural(noun: string): string {
  if (!noun) return noun
  if (/(s|x|z|ch|sh)$/.test(noun)) return `${noun}es`
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`
  return `${noun}s`
}

/** camelCase / PascalCase / kebab / snake → space-separated lowercase words. */
export function humanize(value: string | undefined): string {
  if (!value) return ""
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
}

function arrayLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null
}

function nestedArrayLength(value: unknown, field: string): number | null {
  return isRecord(value) && Array.isArray(value[field]) ? value[field].length : null
}

function commandObjectType(
  intent: Extract<BashIntent, { kind: "sixb" }>,
  parsed: ParsedBashOutput | null
): string | undefined {
  if (intent.command === "objects.list") return optionValue(intent.args, "--type")
  if (intent.command === "objects.get" || intent.command === "objects.inspect") {
    return intent.args[0]
  }
  return findObjectTypeId(parsed?.json)
}

function optionValue(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option)
  return index === -1 ? undefined : args[index + 1]
}

function graphDetail(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.graph)) return undefined
  const objectCount = numberField(value.graph, "objectCount")
  const linkCount = numberField(value.graph, "linkCount")
  const parts = [count(objectCount, "object"), count(linkCount, "link")].filter(Boolean)
  return parts.join(" · ") || undefined
}

/** A single latest telemetry point's value, e.g. "1,240 rpm". */
function latestReading(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const reading = value.value
  const text =
    typeof reading === "number"
      ? reading.toLocaleString()
      : typeof reading === "string" || typeof reading === "boolean"
        ? String(reading)
        : undefined
  if (text === undefined) return undefined
  return typeof value.unit === "string" ? `${text} ${value.unit}` : text
}

function seriesCount(value: unknown): number | null {
  return isRecord(value) && Array.isArray(value.series) ? value.series.length : null
}

/** The outcome word for a queued action request. */
function actionOutcome(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.runId === "string") return value.created === false ? "already queued" : "queued"
  return undefined
}

function runOutcome(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.runId === "string" || typeof value.id === "string") return "queued"
  return runStatus(value)
}

function runStatus(value: unknown): string | undefined {
  return isRecord(value) && typeof value.status === "string" ? humanize(value.status) : undefined
}

function filePath(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  for (const field of ["output", "logicalPath", "path"]) {
    if (typeof value[field] === "string") return value[field]
  }
  return undefined
}

type ActionRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"

interface ActionRunInfo {
  readonly actionId?: string
  readonly status?: ActionRunStatus
  readonly subjectLabel?: string
}

const ACTION_RUN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
])

function actionRunInfo(value: unknown): ActionRunInfo {
  if (!isRecord(value)) return {}
  const status =
    typeof value.status === "string" && ACTION_RUN_STATUSES.has(value.status)
      ? (value.status as ActionRunStatus)
      : undefined
  const actionId = typeof value.actionId === "string" ? value.actionId : undefined
  return { actionId, status, subjectLabel: subjectLabel(value.subject) }
}

/** "customer cust-001" for an object subject, otherwise undefined. */
export function subjectLabel(subject: unknown): string | undefined {
  if (!isRecord(subject) || subject.kind !== "object") return undefined
  const objectTypeId =
    typeof subject.objectTypeId === "string" ? humanize(subject.objectTypeId) : ""
  const primaryId = typeof subject.primaryId === "string" ? subject.primaryId : ""
  return [objectTypeId, primaryId].filter(Boolean).join(" ") || undefined
}

function actionRunTitle(run: ActionRunInfo): string {
  if (!run.status) return "Checked an action run"
  const name = run.actionId ? capitalize(humanize(run.actionId)) : "Action"
  switch (run.status) {
    case "succeeded":
      return `${name} succeeded`
    case "failed":
      return `${name} failed`
    case "running":
      return `Running ${run.actionId ? humanize(run.actionId) : "action"}`
    case "cancelled":
      return `${name} cancelled`
    default:
      return `${name} queued`
  }
}

export function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value
}

/** Count of returned objects across both the list and query response envelopes. */
export function objectCount(value: unknown): number | null {
  if (Array.isArray(value)) return value.length
  if (isRecord(value) && Array.isArray(value.objects)) return value.objects.length
  return null
}

export function numberField(value: unknown, field: string): number | null {
  return isRecord(value) && typeof value[field] === "number" ? value[field] : null
}

function boolField(value: unknown, field: string): boolean | null {
  return isRecord(value) && typeof value[field] === "boolean" ? value[field] : null
}

/** Recursively find the first `objectTypeId` string in a query payload. */
function findObjectTypeId(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObjectTypeId(item)
      if (found) return found
    }
    return undefined
  }
  if (isRecord(value)) {
    if (typeof value.objectTypeId === "string") return value.objectTypeId
    for (const key of Object.keys(value)) {
      const found = findObjectTypeId(value[key])
      if (found) return found
    }
  }
  return undefined
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

function truncateEnd(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
