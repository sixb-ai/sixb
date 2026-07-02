import type { CommandResult, Sandbox } from "@sixb/core"
import { jsonSchema, type Tool, tool } from "ai"

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

/** The sandbox plus its run-scoped env, resolved lazily on first bash use. */
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
): Tool<BashToolInput, BashToolOutput> {
  return tool({
    description: "Run a Bash command in the agent run sandbox.",
    inputSchema: jsonSchema<BashToolInput>({
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["command"],
      additionalProperties: false,
    }),
    async execute(input, { abortSignal }): Promise<BashToolOutput> {
      const { sandbox, env } = await resolveSandbox()
      const result = await sandbox.runCommand("bash", ["-lc", input.command], {
        cwd: input.cwd,
        env,
        timeout: normalizeTimeout(input.timeoutMs),
        signal: abortSignal,
      })
      return truncateCommandResult(result)
    },
  })
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
 *   4. Anything else still oversized (a huge single object, or non-JSON) → middle-truncate the text.
 */
export function compressStdout(text: string, maxChars: number): TruncateResult {
  if (text.length <= maxChars) return { text, truncated: false }

  const json = tryParseJsonDocument(text)
  if (json !== undefined) {
    const compact = JSON.stringify(json)
    if (compact.length <= maxChars) return { text: compact, truncated: false }
    if (Array.isArray(json)) return { text: fitJsonArrayPrefix(json, maxChars), truncated: true }
    // A single object too large even compacted: fall through to a text trim of the compact form.
    return truncateText(compact, maxChars)
  }

  return truncateText(text, maxChars)
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
