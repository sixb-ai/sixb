import { posix } from "node:path"
import { AgentToolPublicError, type CommandResult } from "@sixb/core"
import type { JsonValue, ModelTool } from "@sixb/core/models"
import type { BashSandboxHandle } from "./bash-tool"
import { AgentToolExecutionError } from "./errors"
import { agentToolErrorText } from "./model-adapters"

const DEFAULT_LIMIT = 2_000
const MAX_BYTES = 50 * 1024
const PROBE_BYTES = MAX_BYTES + 5
const READ_TIMEOUT_MS = 30_000

export interface ReadToolInput {
  readonly path: string
  readonly offset?: number
  readonly limit?: number
}

export interface ReadToolOutput {
  readonly path: string
  readonly content: string
  readonly startLine: number
  readonly endLine: number
  readonly truncated: boolean
  readonly nextOffset?: number
}

/** Build the bounded UTF-8 file reader from the run's lazy sandbox resolver. */
export function createReadTool(
  resolveSandbox: () => Promise<BashSandboxHandle>
): ModelTool<ReadToolInput> {
  return {
    name: "read",
    description:
      "Read a UTF-8 text file relative to the sandbox working directory. Returns at most 2,000 lines or 50 KiB and includes nextOffset when more content remains. Prefer this over bash for reading files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the sandbox working directory." },
        offset: { type: "integer", minimum: 1, description: "One-based start line. Default: 1." },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Requested line count. Default and maximum: 2,000.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    parseInput: parseReadToolInput,
    async execute(input, { signal }): Promise<JsonValue> {
      const path = normalizePath(input.path)
      const offset = positiveInteger(input.offset, 1, "offset")
      const limit = Math.min(positiveInteger(input.limit, DEFAULT_LIMIT, "limit"), DEFAULT_LIMIT)

      let result: CommandResult
      try {
        const { sandbox, env } = await resolveSandbox()
        result = await sandbox.runCommand(
          "bash",
          [
            "-c",
            READ_SCRIPT,
            "sixb-read",
            path,
            String(offset),
            String(limit),
            String(PROBE_BYTES),
          ],
          {
            cwd: sandbox.workingDirectory,
            env,
            timeout: READ_TIMEOUT_MS,
            signal,
          }
        )
      } catch (error) {
        signal.throwIfAborted()
        throw new AgentToolExecutionError("read", { cause: error })
      }

      signal.throwIfAborted()
      if (result.exitCode !== 0) throwReadError(path, result.exitCode, result.stderr)

      const page = paginate(decodeBase64(result.stdout), path, offset, limit)
      const endLine = offset + page.lineCount - 1
      return {
        path,
        content: page.content,
        startLine: offset,
        endLine,
        truncated: page.truncated,
        ...(page.truncated ? { nextOffset: endLine + 1 } : {}),
      } as JsonValue
    },
    errorText: agentToolErrorText,
  }
}

function parseReadToolInput(value: unknown): ReadToolInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw publicError("input must be an object.")
  }
  const input = value as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (key !== "path" && key !== "offset" && key !== "limit") {
      throw publicError(`input contains unknown property '${key}'.`)
    }
  }
  const path = normalizePath(input.path)
  const offset = input.offset === undefined ? undefined : positiveInteger(input.offset, 1, "offset")
  const limit = input.limit === undefined ? undefined : positiveInteger(input.limit, 1, "limit")
  return {
    path,
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  }
}

function normalizePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0") || posix.isAbsolute(value)) {
    throw publicError("path must be a non-empty relative path.")
  }
  const normalized = posix.normalize(value)
  if (normalized === ".." || normalized.startsWith("../")) {
    throw publicError("path must stay within the sandbox working directory.")
  }
  return normalized
}

function positiveInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw publicError(`${field} must be a positive integer.`)
  }
  return value
}

function decodeBase64(value: string): Uint8Array {
  const encoded = value.replace(/[\t\n\r ]/g, "")
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new AgentToolExecutionError("read", { cause: new Error("Invalid sandbox output.") })
  }
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.byteLength > PROBE_BYTES) {
    throw new AgentToolExecutionError("read", { cause: new Error("Oversized sandbox output.") })
  }
  return bytes
}

function paginate(
  bytes: Uint8Array,
  path: string,
  offset: number,
  limit: number
): { readonly content: string; readonly lineCount: number; readonly truncated: boolean } {
  if (bytes.byteLength === 0) {
    if (offset > 1) throw publicError(`offset ${offset} is beyond the end of '${path}'.`)
    return { content: "", lineCount: 1, truncated: false }
  }
  if (bytes.includes(0)) throw publicError(`'${path}' is binary, not UTF-8 text.`)

  let cursor = 0
  let lineCount = 0
  let selectedEnd = 0
  let truncated = false

  while (cursor < bytes.byteLength) {
    if (lineCount === limit) {
      truncated = true
      break
    }
    const newline = bytes.indexOf(10, cursor)
    if (newline === -1) {
      if (bytes.byteLength === PROBE_BYTES || bytes.byteLength > MAX_BYTES) {
        truncated = true
        break
      }
      lineCount += 1
      selectedEnd = bytes.byteLength
      cursor = bytes.byteLength
      break
    }
    if (newline > MAX_BYTES) {
      truncated = true
      break
    }
    lineCount += 1
    selectedEnd = newline
    cursor = newline + 1
  }

  if (cursor < bytes.byteLength) truncated = true
  if (lineCount === 0) {
    throw publicError(`line ${offset} of '${path}' exceeds the 50 KiB read limit.`)
  }

  let content: string
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, selectedEnd))
  } catch {
    throw publicError(`'${path}' is binary, not UTF-8 text.`)
  }
  return { content, lineCount, truncated }
}

function throwReadError(path: string, exitCode: number, stderr: string): never {
  if (exitCode === 10) throw publicError(`'${path}' does not exist or cannot be resolved.`)
  if (exitCode === 11)
    throw publicError(`'${path}' resolves outside the sandbox working directory.`)
  if (exitCode === 12) throw publicError(`'${path}' is a directory, not a file.`)
  if (exitCode === 13) throw publicError(`'${path}' is not a regular file.`)
  if (exitCode === 14) throw publicError(`'${path}' is not readable.`)
  const missingCommand = READ_COMMAND_BY_EXIT_CODE[exitCode]
  if (missingCommand) {
    throw publicError(`is unavailable because the sandbox image is missing '${missingCommand}'.`)
  }
  throw new AgentToolExecutionError("read", {
    cause: new Error(stderr.trim() || `Sandbox read exited with code ${exitCode}.`),
  })
}

function publicError(message: string): AgentToolPublicError {
  return new AgentToolPublicError(`[SixbAgentWorker] read ${message}`)
}

const READ_SCRIPT = `set -u
realpath_bin="$(command -v realpath)" || exit 15
tail_bin="$(command -v tail)" || exit 16
head_bin="$(command -v head)" || exit 17
base64_bin="$(command -v base64)" || exit 18
root="$(pwd -P)"
target="$("$realpath_bin" "$root/$1")" || exit 10
case "$target" in "$root"|"$root"/*) ;; *) exit 11 ;; esac
[ -e "$target" ] || exit 10
[ ! -d "$target" ] || exit 12
[ -f "$target" ] || exit 13
[ -r "$target" ] || exit 14
export LC_ALL=C
"$tail_bin" -n "+$2" -- "$target" | "$head_bin" -n "$(($3 + 1))" | "$head_bin" -c "$4" | "$base64_bin"
for status in "\${PIPESTATUS[@]}"; do
  case "$status" in 0|141) ;; *) exit 19 ;; esac
done`

const READ_COMMAND_BY_EXIT_CODE: Readonly<Record<number, string>> = {
  15: "realpath",
  16: "tail",
  17: "head",
  18: "base64",
}
