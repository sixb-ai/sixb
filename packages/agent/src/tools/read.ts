import { posix } from "node:path"
import { AgentToolPublicError, type CommandResult } from "@sixb/core"
import { isAgentToolResult } from "@sixb/core/internal/agents"
import type { JsonObject, JsonValue, ModelTool } from "@sixb/core/models"
import { AgentToolExecutionError } from "../errors"
import { agentToolErrorText } from "../model-adapters"
import { type AgentSandboxHandle, contextPath } from "../sandbox-handle"
import { FINGERPRINT_FUNCTIONS, type FileReadLedger, isFingerprint } from "./file-writes"
import { isKnownSandboxFile, type SandboxFileViewer, viewSandboxFile } from "./view-file"

const DEFAULT_LIMIT = 2_000
const MAX_BYTES = 50 * 1024
const PROBE_BYTES = MAX_BYTES + 5
const READ_TIMEOUT_MS = 30_000
const MAX_DIRECTORY_ENTRIES = 500
/** Shown as themselves, never paged as text. */
const VIEWED_FILE = /\.(png|jpe?g|gif|webp|pdf)$/i

export const READ_TOOL_SPEC = {
  name: "read",
  strict: true,
  description:
    "Read a file, or list a directory. Text comes as at most 2,000 lines or 50 KiB, with nextOffset when more remains; an image or a PDF comes as itself; a directory as its entries, folders ending in /. Prefer this over bash for reading files.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Path relative to the working directory, or an absolute path in the run's context directory.",
      },
      offset: { type: "integer", minimum: 1, description: "One-based start line. Default: 1." },
      limit: {
        type: "integer",
        minimum: 1,
        description: "Requested line count. Default and maximum: 2,000.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  } satisfies JsonObject,
} as const

export interface ReadToolInput {
  readonly path: string
  readonly offset?: number
  readonly limit?: number
}

/** A directory's entries, names only, folders ending in `/`. */
export interface ReadDirectoryOutput {
  readonly path: string
  readonly entries: readonly string[]
  readonly truncated?: true
}

export interface ReadToolOutput {
  readonly path: string
  readonly content: string
  readonly startLine: number
  readonly endLine: number
  readonly truncated: boolean
  readonly nextOffset?: number
}

/** Build the reader from the run's lazy sandbox resolver. */
export function createReadTool(
  resolveSandbox: () => Promise<AgentSandboxHandle>,
  /** Where each read is recorded, so `edit` and `write` change only a file the run has read. */
  ledger?: FileReadLedger,
  /** Shows images, PDFs and other files that are not text; without it, they are refused. */
  viewer?: SandboxFileViewer
): ModelTool<ReadToolInput> {
  return {
    ...READ_TOOL_SPEC,
    parseInput: parseReadToolInput,
    async execute(input, { signal, toolCallId }): Promise<JsonValue> {
      const path = normalizePath(input.path)
      const offset = positiveInteger(input.offset, 1, "offset")
      const limit = Math.min(positiveInteger(input.limit, DEFAULT_LIMIT, "limit"), DEFAULT_LIMIT)

      let handle: AgentSandboxHandle
      let result: CommandResult
      try {
        handle = await resolveSandbox()
        if (viewer && (VIEWED_FILE.test(path) || isKnownSandboxFile(viewer, handle, path))) {
          return await viewSandboxFile(viewer, handle, { path, toolCallId, signal })
        }
        const { sandbox, env } = handle
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
            contextPath(handle),
            String(MAX_DIRECTORY_ENTRIES + 1),
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
        if (error instanceof AgentToolPublicError) throw error
        throw new AgentToolExecutionError("read", { cause: error })
      }

      signal.throwIfAborted()
      if (result.exitCode !== 0) throwReadError(path, result.exitCode, result.stderr)

      const [first = "", second = "", ...rest] = result.stdout.split("\n")
      if (first === "directory") return directoryListing(path, [second, ...rest])

      if (isFingerprint(first) && second) ledger?.record(second, first)
      let page: ReturnType<typeof paginate>
      try {
        page = paginate(decodeBase64(rest.join("\n")), path, offset, limit)
      } catch (error) {
        if (!(error instanceof NotTextError) || !viewer) throw error
        return viewSandboxFile(viewer, handle, { path, toolCallId, signal })
      }
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
    // A file shown as itself reaches the model through the run's media bridge; text as it is.
    toModelOutput(output, { signal, toolCallId }) {
      return viewer && isAgentToolResult(output)
        ? viewer.toolResultToModelOutput({ output, signal, toolCallId })
        : { type: "json", value: output }
    },
    errorText: agentToolErrorText,
  }
}

function directoryListing(path: string, lines: readonly string[]): JsonValue {
  const entries = lines.filter((line) => line !== "")
  const truncated = entries.length > MAX_DIRECTORY_ENTRIES
  return {
    path,
    entries: entries.slice(0, MAX_DIRECTORY_ENTRIES),
    ...(truncated ? { truncated: true } : {}),
  } satisfies ReadDirectoryOutput
}

/** A file that is not UTF-8 text: shown as itself when the run can, refused otherwise. */
class NotTextError extends AgentToolPublicError {}

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

/** The sandbox checks where a path really leads: here only its form. */
function normalizePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw publicError("path must be a non-empty path.")
  }
  return posix.normalize(value)
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
  if (bytes.includes(0)) throw notText(path)

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
    throw notText(path)
  }
  return { content, lineCount, truncated }
}

function throwReadError(path: string, exitCode: number, stderr: string): never {
  if (exitCode === 10) throw publicError(`'${path}' does not exist or cannot be resolved.`)
  if (exitCode === 11)
    throw publicError(
      `'${path}' resolves outside the working directory and the run's context directory.`
    )
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

function notText(path: string): NotTextError {
  return new NotTextError(`[SixbAgent] read '${path}' is binary, not UTF-8 text.`)
}

function publicError(message: string): AgentToolPublicError {
  return new AgentToolPublicError(`[SixbAgent] read ${message}`)
}

const READ_SCRIPT = `set -u
realpath_bin="$(command -v realpath)" || exit 15
tail_bin="$(command -v tail)" || exit 16
head_bin="$(command -v head)" || exit 17
base64_bin="$(command -v base64)" || exit 18
root="$(pwd -P)"
context="$root"
if [ -d "$5" ]; then context="$(cd -P -- "$5" && pwd)"; fi
case "$1" in /*) requested="$1" ;; *) requested="$root/$1" ;; esac
target="$("$realpath_bin" "$requested")" || exit 10
case "$target" in "$root"|"$root"/*|"$context"/*) ;; *) exit 11 ;; esac
[ -e "$target" ] || exit 10
if [ -d "$target" ]; then
  printf 'directory\\n'
  LC_ALL=C ls -1Ap -- "$target" | "$head_bin" -n "$6"
  exit 0
fi
[ -f "$target" ] || exit 13
[ -r "$target" ] || exit 14
cksum_bin="$(command -v cksum)" || exit 20
${FINGERPRINT_FUNCTIONS}
export LC_ALL=C
fingerprint "$target" || printf '\\n'
print_path "$target"
"$tail_bin" -n "+$2" -- "$target" | "$head_bin" -n "$(($3 + 1))" | "$head_bin" -c "$4" | "$base64_bin"
for status in "\${PIPESTATUS[@]}"; do
  case "$status" in 0|141) ;; *) exit 19 ;; esac
done`

const READ_COMMAND_BY_EXIT_CODE: Readonly<Record<number, string>> = {
  15: "realpath",
  16: "tail",
  17: "head",
  18: "base64",
  20: "cksum",
}
