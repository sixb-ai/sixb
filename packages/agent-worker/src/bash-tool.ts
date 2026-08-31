import type { CommandResult, Sandbox } from "@sixb/core"
import type { JsonValue, ModelTool } from "@sixb/core/models"

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
const MAX_COMMAND_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_CHARS = 20_000

interface BashToolInput {
  readonly command: string
  readonly cwd?: string
  readonly timeoutMs?: number
}

export interface BashToolOutput extends CommandResult {
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

/** The sandbox plus its run-scoped env, resolved lazily on first sandbox tool use. */
export interface BashSandboxHandle {
  readonly sandbox: Sandbox
  readonly env?: Readonly<Record<string, string>>
}

/**
 * Build the bash tool from a resolver that yields the sandbox on demand. The
 * resolver is awaited on the first command, not at tool-construction time, so
 * sandbox creation can run concurrently with the model's first response instead
 * of blocking the turn. A resolver rejection surfaces as a failed command.
 */
export function createBashTool(
  resolveSandbox: () => Promise<BashSandboxHandle>
): ModelTool<BashToolInput> {
  return {
    name: "bash",
    description: "Run a Bash command in the agent run sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    parseInput: parseBashToolInput,
    async execute(input, { signal }): Promise<JsonValue> {
      const { sandbox, env } = await resolveSandbox()
      const result = await sandbox.runCommand("bash", ["-lc", input.command], {
        cwd: input.cwd,
        env,
        timeout: normalizeTimeout(input.timeoutMs),
        signal,
      })
      return truncateCommandResult(result) as unknown as JsonValue
    },
    errorText: () => "The command failed.",
  }
}

function parseBashToolInput(value: unknown): BashToolInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Bash tool input must be an object.")
  }
  const input = value as Record<string, unknown>
  if (typeof input.command !== "string" || input.command.length === 0) {
    throw new TypeError("Bash tool input.command must be a non-empty string.")
  }
  if (input.cwd !== undefined && typeof input.cwd !== "string") {
    throw new TypeError("Bash tool input.cwd must be a string when provided.")
  }
  if (input.timeoutMs !== undefined && typeof input.timeoutMs !== "number") {
    throw new TypeError("Bash tool input.timeoutMs must be a number when provided.")
  }
  for (const key of Object.keys(input)) {
    if (key !== "command" && key !== "cwd" && key !== "timeoutMs") {
      throw new TypeError(`Bash tool input contains unknown property '${key}'.`)
    }
  }
  return {
    command: input.command,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  }
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_COMMAND_TIMEOUT_MS
  }
  return Math.min(Math.floor(timeoutMs), MAX_COMMAND_TIMEOUT_MS)
}

function truncateCommandResult(result: CommandResult): BashToolOutput {
  // stdout is usually a Sixb API JSON response: compact it (and, if still oversized, keep a valid
  // structural prefix) so both the model and the chat UI receive parseable JSON rather than a body
  // cut mid-structure. stderr is diagnostics, so it just gets a lossless-in-the-middle text trim.
  const stdout = compressStdout(result.stdout, DEFAULT_MAX_OUTPUT_CHARS)
  const stderr = truncateText(result.stderr, DEFAULT_MAX_OUTPUT_CHARS)
  return {
    ...result,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  }
}

interface TruncateResult {
  readonly text: string
  readonly truncated: boolean
}

/**
 * Fit a command's stdout under `maxChars`, preferring to keep it valid JSON.
 *
 * The agent's commands (and any `jq` pretty-printing it adds) mostly produce JSON API responses. We
 * compress in the order the field recommends — reformat first, drop data only if we must:
 *   1. Under budget already → leave it untouched.
 *   2. Valid JSON → re-serialize compact; whitespace alone often brings it under budget with zero
 *      data loss (compact JSON is also fewer tokens and no worse for model comprehension).
 *   3. Still oversized JSON array → keep the largest whole-element prefix that fits, as a bare array
 *      (same shape the caller expects, still valid JSON, just fewer rows).
 *   4. Oversized JSON object → return a valid JSON preview that tells the agent to narrow the call.
 *   5. Oversized non-JSON → middle-truncate the text.
 */
export function compressStdout(text: string, maxChars: number): TruncateResult {
  if (text.length <= maxChars) return { text, truncated: false }

  const json = tryParseJsonDocument(text)
  if (json !== undefined) {
    const compact = JSON.stringify(json)
    if (compact.length <= maxChars) return { text: compact, truncated: false }
    if (Array.isArray(json)) return { text: fitJsonArrayPrefix(json, maxChars), truncated: true }
    if (typeof json === "object" && json !== null) {
      return { text: fitJsonObjectPreview(json, compact, maxChars), truncated: true }
    }
    return truncateText(compact, maxChars)
  }

  return truncateText(text, maxChars)
}

/** A parseable diagnostic plus as much leading source JSON as the budget allows. */
function fitJsonObjectPreview(value: object, compact: string, maxChars: number): string {
  const base = {
    _sixbOutputTruncated: true,
    message:
      "Command output exceeded the tool limit; rerun with a smaller limit or narrower query.",
    topLevelKeys: Object.keys(value).slice(0, 50),
    preview: "",
  }
  if (JSON.stringify(base).length > maxChars) {
    const minimal = JSON.stringify({ _sixbOutputTruncated: true })
    return minimal.length <= maxChars ? minimal : "{}"
  }

  let low = 0
  let high = compact.length
  let best = ""
  while (low <= high) {
    const length = (low + high) >> 1
    const candidate = JSON.stringify({ ...base, preview: compact.slice(0, length) })
    if (candidate.length <= maxChars) {
      best = candidate
      low = length + 1
    } else {
      high = length - 1
    }
  }
  return best || JSON.stringify(base)
}

/** The largest whole-element prefix of `items` whose compact JSON fits under `maxChars`. */
function fitJsonArrayPrefix(items: readonly unknown[], maxChars: number): string {
  let low = 0
  let high = items.length
  let best = 0
  while (low <= high) {
    const mid = (low + high) >> 1
    if (JSON.stringify(items.slice(0, mid)).length <= maxChars) {
      best = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return JSON.stringify(items.slice(0, best))
}

/** JSON.parse, but only for object/array documents — never a bare number/string/bool. */
function tryParseJsonDocument(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/** Keep the head and tail, dropping the middle — so trailing errors and exit lines survive. */
function truncateText(text: string, maxChars: number): TruncateResult {
  if (text.length <= maxChars) return { text, truncated: false }
  const marker = `\n…[SixbAgentWorker] output truncated to ${maxChars} characters]…\n`
  const budget = Math.max(0, maxChars - marker.length)
  const head = Math.ceil(budget / 2)
  const tail = budget - head
  return {
    text: text.slice(0, head) + marker + (tail > 0 ? text.slice(text.length - tail) : ""),
    truncated: true,
  }
}
