// Interpret the single `bash` tool into a human-friendly view. The agent only ever does a small,
// predictable set of things — read a Sixb Agent Skill, curl the per-run Sixb API proxy, or run a
// plain shell command — because we author the skills and the proxy that shape those commands. This
// module turns the raw `{ command }` input and `{ exitCode, stdout, ... }` output into a typed
// intent plus a friendly title, so the UI can render native views instead of escaped JSON.

/** The bash tool input as authored by the agent. */
export interface BashInput {
  readonly command: string
  readonly cwd?: string
  readonly timeoutMs?: number
}

/** The bash tool output envelope returned by the sandbox (see agent-worker `BashToolOutput`). */
export interface BashOutput {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

/** What the agent was trying to do, derived from the command string. */
export type BashIntent =
  | { readonly kind: "api-object-types" }
  | { readonly kind: "api-object-type-detail"; readonly objectTypeId: string }
  | { readonly kind: "api-objects-list"; readonly objectTypeId?: string }
  | { readonly kind: "api-objects-query"; readonly objectTypeId?: string }
  | { readonly kind: "api-count"; readonly objectTypeId?: string }
  | { readonly kind: "api-exists"; readonly objectTypeId?: string }
  | { readonly kind: "api-facets"; readonly objectTypeId?: string }
  | { readonly kind: "api-object-detail"; readonly objectTypeId: string; readonly objectId: string }
  | {
      readonly kind: "api-telemetry-latest"
      readonly objectId: string
      readonly propertyId: string
    }
  | {
      readonly kind: "api-telemetry-history"
      readonly objectId: string
      readonly propertyId: string
    }
  | { readonly kind: "api-telemetry-bulk" }
  | { readonly kind: "api-actions-list" }
  | { readonly kind: "api-action-request"; readonly actionId: string }
  | { readonly kind: "api-action-run"; readonly runId: string }
  | { readonly kind: "api-project" }
  | { readonly kind: "read-skill"; readonly skillName?: string; readonly reference?: string }
  | { readonly kind: "generic"; readonly command: string }

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
  const api = extractApiRequest(command)
  if (api) {
    return classifyApiRequest(api)
  }
  const skill = classifySkillRead(command)
  if (skill) return skill
  return { kind: "generic", command: command.trim() }
}

interface ApiRequest {
  readonly method: string
  readonly segments: readonly string[]
  readonly query: URLSearchParams
  readonly body: unknown
}

/** Pull the `/api/...` request out of a curl command, independent of the base-URL placeholder. */
function extractApiRequest(command: string): ApiRequest | null {
  const match = command.match(/\/api\/[^\s"'`]*/)
  if (!match) return null

  const raw = match[0]
  const queryIndex = raw.indexOf("?")
  const path = queryIndex === -1 ? raw : raw.slice(0, queryIndex)
  const query = new URLSearchParams(queryIndex === -1 ? "" : raw.slice(queryIndex + 1))
  const segments = path.split("/").filter(Boolean).slice(1) // drop leading "api"

  // Detect the method on the command with quoted spans blanked out, so a `-X`/`-d` token that only
  // appears inside the URL, a header value, or a JSON body is never mistaken for a real curl flag.
  const flags = command.replace(/'[^']*'|"[^"]*"/g, " ")
  const explicitMethod = flags.match(/(?:-X|--request)\s*([A-Za-z]+)/)?.[1]
  // curl treats a body flag with no explicit method as an implicit POST, so infer it here rather
  // than mislabelling e.g. `curl .../api/actions/:id -d '{}'` as a GET (an actions list).
  const method = explicitMethod
    ? explicitMethod.toUpperCase()
    : CURL_DATA_FLAG_RE.test(flags)
      ? "POST"
      : "GET"

  return { method, segments, query, body: extractCurlBody(command) }
}

// A curl body flag (`-d`, `--data`, `--data-raw|binary|ascii|urlencode`) as a standalone token,
// including glued forms (`-d@file`, `--data=…`). Detects presence for method inference only — apply
// it to the quote-blanked command so payload text can't trigger a false match.
const CURL_DATA_FLAG_RE = /(?:^|\s)(?:--data(?:-raw|-binary|-ascii|-urlencode)?|-d)(?=[\s=@])/

/** Extract and JSON-parse a curl `--data '...'` / `-d '...'` payload, if present. */
function extractCurlBody(command: string): unknown {
  const match = command.match(/(?:--data(?:-raw|-binary|-ascii)?|-d)\s+(['"])([\s\S]*?)\1/)
  if (!match) return undefined
  return tryParseJson(match[2])
}

function classifyApiRequest(api: ApiRequest): BashIntent {
  const [head, ...rest] = api.segments

  if (head === "project") return { kind: "api-project" }

  // Bulk telemetry lives at the top level: POST /api/telemetry/history
  if (head === "telemetry") return { kind: "api-telemetry-bulk" }

  if (head === "object-types") {
    return rest.length === 0
      ? { kind: "api-object-types" }
      : { kind: "api-object-type-detail", objectTypeId: rest[0] }
  }

  if (head === "actions") {
    if (rest.length === 0) return { kind: "api-actions-list" }
    if (api.method === "POST") return { kind: "api-action-request", actionId: rest[0] }
    return { kind: "api-actions-list" }
  }

  // Action run lifecycle: GET /api/action-runs/:runId
  if (head === "action-runs" && rest.length >= 1) {
    return { kind: "api-action-run", runId: rest[0] }
  }

  if (head === "objects") {
    return classifyObjectsRequest(api, rest)
  }

  return { kind: "generic", command: api.segments.join("/") }
}

function classifyObjectsRequest(api: ApiRequest, rest: readonly string[]): BashIntent {
  if (rest.length === 0) {
    return { kind: "api-objects-list", objectTypeId: api.query.get("objectTypeId") ?? undefined }
  }

  if (rest[0] === "query") {
    const objectTypeId = findObjectTypeId(api.body)
    if (rest[1] === "count") return { kind: "api-count", objectTypeId }
    if (rest[1] === "exists") return { kind: "api-exists", objectTypeId }
    if (rest[1] === "facets") return { kind: "api-facets", objectTypeId }
    return { kind: "api-objects-query", objectTypeId }
  }

  // /api/objects/:type/:id/telemetry/:prop/(latest|history)
  if (rest.length >= 4 && rest[2] === "telemetry" && rest[3]) {
    const objectId = rest[1]
    const propertyId = rest[3]
    return rest[4] === "history"
      ? { kind: "api-telemetry-history", objectId, propertyId }
      : { kind: "api-telemetry-latest", objectId, propertyId }
  }
  if (rest.length >= 2) {
    return { kind: "api-object-detail", objectTypeId: rest[0], objectId: rest[1] }
  }

  return { kind: "api-objects-list", objectTypeId: rest[0] }
}

const SKILL_READ_RE = /\b(?:cat|less|bat|head|tail|sed|nl)\b/

function classifySkillRead(command: string): BashIntent | null {
  const looksLikeRead = SKILL_READ_RE.test(command)
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

export interface BashDescription {
  readonly icon: BashIcon
  /** Past-tense headline once the command has run, e.g. "Explored the ontology". */
  readonly title: string
  /** Present-progressive headline while running, e.g. "Exploring the ontology". */
  readonly runningTitle: string
  /** Optional secondary line derived from the result, e.g. "8 object types". */
  readonly detail?: string
}

export function describeBash(intent: BashIntent, parsed: ParsedBashOutput | null): BashDescription {
  switch (intent.kind) {
    case "api-object-types": {
      const n = arrayLength(parsed?.json)
      return icon(
        "ontology",
        "Explored the ontology",
        "Exploring the ontology",
        count(n, "object type")
      )
    }
    case "api-object-type-detail":
      return icon(
        "ontology",
        `Inspected the ${humanize(intent.objectTypeId)} type`,
        `Inspecting the ${humanize(intent.objectTypeId)} type`
      )
    case "api-objects-list":
    case "api-objects-query": {
      const n = objectCount(parsed?.json)
      const label = humanize(intent.objectTypeId) || "object"
      const title = n === null ? "Queried objects" : `Found ${count(n, label)}`
      return icon("objects", title, `Looking up ${plural(label)}`)
    }
    case "api-count": {
      const value = numberField(parsed?.json, "count")
      const label = humanize(intent.objectTypeId) || "objects"
      return icon(
        "count",
        `Counted ${plural(label)}`,
        `Counting ${plural(label)}`,
        value === null ? undefined : value.toLocaleString()
      )
    }
    case "api-exists": {
      const value = boolField(parsed?.json, "exists")
      return icon(
        "count",
        "Checked for matches",
        "Checking for matches",
        value === null ? undefined : value ? "Yes" : "No"
      )
    }
    case "api-facets":
      return icon("facets", "Broke down the data", "Breaking down the data")
    case "api-object-detail":
      return icon("object", `Opened ${intent.objectId}`, `Opening ${intent.objectId}`)
    case "api-telemetry-latest":
      return icon(
        "telemetry",
        `Read latest ${humanize(intent.propertyId)}`,
        `Reading latest ${humanize(intent.propertyId)}`,
        latestReading(parsed?.json)
      )
    case "api-telemetry-history": {
      const n = arrayLength(parsed?.json)
      return icon(
        "telemetry",
        `Read ${humanize(intent.propertyId)} history`,
        `Reading ${humanize(intent.propertyId)} history`,
        count(n, "point")
      )
    }
    case "api-telemetry-bulk": {
      const n = seriesCount(parsed?.json)
      return icon(
        "telemetry",
        "Compared telemetry series",
        "Comparing telemetry series",
        n === null ? undefined : `${n} series`
      )
    }
    case "api-action-run": {
      const run = actionRunInfo(parsed?.json)
      return icon("actions", actionRunTitle(run), "Checking the action run", run.subjectLabel)
    }
    case "api-actions-list":
      return icon("actions", "Listed available actions", "Listing available actions")
    case "api-action-request":
      return icon(
        "actions",
        `Ran the ${humanize(intent.actionId)} action`,
        `Running the ${humanize(intent.actionId)} action`,
        actionOutcome(parsed?.json)
      )
    case "api-project":
      return icon("project", "Read project info", "Reading project info")
    case "read-skill": {
      const label = skillLabel(intent)
      return icon("skill", `Read the ${label}`, `Reading the ${label}`)
    }
    default:
      return icon(
        "terminal",
        "Ran a command",
        "Running a command",
        truncateMiddle(intent.command, 64)
      )
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

export type ActionRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"

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

function numberField(value: unknown, field: string): number | null {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
