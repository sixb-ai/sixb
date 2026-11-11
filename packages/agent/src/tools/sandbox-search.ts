import { AgentToolPublicError, type CommandResult } from "@sixb/core"
import { AgentToolExecutionError } from "../errors"
import { type AgentSandboxHandle, contextPath } from "../sandbox-handle"
import { pathInput } from "./edit"
import { publicError } from "./file-writes"
import type { GlobSearchRequest, GrepSearchRequest, SearchErrorCode } from "./search/request"

/** How long a search walks before it returns what it found, marked incomplete. */
const SEARCH_DEADLINE_MS = 20_000
/** The walk's deadline, plus the time to start the script. */
const COMMAND_TIMEOUT_MS = 30_000

type SearchTool = "glob" | "grep"

type SandboxSearchRequest =
  | Omit<GlobSearchRequest, "contextDirectory" | "timeoutMs">
  | Omit<GrepSearchRequest, "contextDirectory" | "timeoutMs">

/**
 * Search with the run's `lib/search.mjs`, the same in every sandbox and on a computer. The script
 * confines the search to the working directory and the context directory, as `read` does, and
 * prints one JSON line. Returns that result, unchecked.
 *
 * A search that ran too long, or a script that could not search, is the model's to know: it can
 * narrow the search, or fall back to bash.
 */
export async function runSandboxSearch(
  handle: AgentSandboxHandle,
  request: SandboxSearchRequest,
  signal: AbortSignal
): Promise<unknown> {
  const tool = request.tool
  const body = JSON.stringify({
    ...request,
    contextDirectory: contextPath(handle),
    timeoutMs: SEARCH_DEADLINE_MS,
  })

  let result: CommandResult
  try {
    result = await handle.sandbox.runCommand(
      "bash",
      ["-c", RUN_SEARCH, `sixb-${tool}`, contextPath(handle, "lib", "search.mjs"), body],
      {
        cwd: handle.sandbox.workingDirectory,
        env: handle.env ?? {},
        timeout: COMMAND_TIMEOUT_MS,
        signal,
      }
    )
  } catch (error) {
    signal.throwIfAborted()
    throw new AgentToolExecutionError(tool, { cause: error })
  }
  signal.throwIfAborted()

  const cause = new Error(result.stderr.trim() || `search.mjs exited with code ${result.exitCode}.`)

  if (result.timedOut) {
    throw new AgentToolPublicError(
      `[SixbAgent] ${tool}: The search took too long: ${
        tool === "grep"
          ? "narrow the path, simplify the pattern, or pass literal: true."
          : "narrow the path or the pattern."
      }`,
      { cause }
    )
  }

  if (result.exitCode === 0) {
    const output = lastJsonLine(result.stdout)
    if (output !== undefined) return output
    throw searchUnavailable(tool, "its output could not be read", cause)
  }

  const failure = scriptFailure(lastJsonLine(result.stderr))
  if (result.exitCode === 2 && failure && isSearchErrorCode(failure.code)) {
    throw searchError(tool, request.path ?? ".", failure.code, failure.message)
  }
  throw searchUnavailable(tool, unavailableReason(result.exitCode, failure), cause)
}

/**
 * A search the run's script could not make: the model reads why, in words of ours rather than the
 * sandbox's, and the way out. The script's own words stay in the cause.
 */
export function searchUnavailable(
  tool: SearchTool,
  reason: string,
  cause: unknown
): AgentToolPublicError {
  return new AgentToolPublicError(
    `[SixbAgent] ${tool}: The search could not run in this sandbox (${reason}): use bash with find and grep instead.`,
    { cause }
  )
}

function unavailableReason(
  exitCode: number,
  failure: { readonly code: string; readonly message: string } | undefined
): string {
  if (failure?.code === "runtime_unavailable") return "the search script needs Bun or Node.js"
  if (failure?.code === "script_missing") return "the run has no search script"
  return `the search script exited with code ${exitCode}`
}

/** An optional value left out: models send `"null"` or `"undefined"` for one. */
export function isLeftOut(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    value === "null" ||
    value === "undefined"
  )
}

export function optionalPathInput(value: unknown, tool: SearchTool): string | undefined {
  return isLeftOut(value) ? undefined : pathInput(value, tool)
}

export const INCOMPLETE_SEARCH_FOOTER =
  "(The search stopped after 20 seconds, before it looked everywhere: narrow the pattern or the path)"

function searchError(tool: SearchTool, path: string, code: SearchErrorCode, reason: string): Error {
  switch (code) {
    case "path_missing":
      return publicError(tool, `'${path}' does not exist.`)
    case "path_outside":
      return publicError(
        tool,
        `'${path}' resolves outside the working directory and the run's context directory.`
      )
    case "path_is_file":
      return publicError(tool, `'${path}' is a file: read it, or grep it.`)
    case "path_not_searchable":
      return publicError(tool, `'${path}' is not a file or a directory.`)
    case "invalid_pattern":
      return publicError(
        tool,
        tool === "grep"
          ? `Invalid pattern: ${reason}. Pass literal: true to search the text as written.`
          : `Invalid pattern: ${reason}.`
      )
    case "invalid_include":
      return publicError(tool, `Invalid include: ${reason}.`)
    case "file_binary":
      return publicError(tool, `'${path}' is binary, or not UTF-8 text: ${tool} searches text.`)
    case "file_too_large":
      return publicError(tool, `'${path}' is over 10 MiB: search it with bash.`)
  }
}

const SEARCH_ERROR_CODES: readonly SearchErrorCode[] = [
  "path_missing",
  "path_outside",
  "path_is_file",
  "path_not_searchable",
  "invalid_pattern",
  "invalid_include",
  "file_binary",
  "file_too_large",
]

function isSearchErrorCode(value: unknown): value is SearchErrorCode {
  return SEARCH_ERROR_CODES.some((code) => code === value)
}

/** The script's `{ error: { code, message } }`. */
function scriptFailure(
  value: unknown
): { readonly code: string; readonly message: string } | undefined {
  const error = isRecord(value) ? value.error : undefined
  if (!isRecord(error) || typeof error.code !== "string" || typeof error.message !== "string") {
    return undefined
  }
  return { code: error.code, message: error.message }
}

/**
 * The last line that parses as JSON: in the login-shell fallback, a profile may print before the
 * script does.
 */
function lastJsonLine(text: string): unknown {
  const lines = text.split("\n").filter((line) => line.trim() !== "")
  const last = lines.at(-1)
  if (last === undefined) return undefined

  try {
    return JSON.parse(last)
  } catch {
    return undefined
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Runs the script at its absolute path on Bun, or else Node. Preflight found one of them in a
 * login shell: when this shell's PATH has neither, the search runs in one, as `exec` so no logout
 * script runs. A missing script, or a login shell with neither, prints an error as the script
 * does.
 *
 * Arguments: the script's path, the request.
 */
const RUN_SEARCH = `set -u
if [ ! -r "$1" ]; then
  echo '{"error":{"code":"script_missing","message":"The search script is missing."}}' >&2
  exit 2
fi
command -v bun >/dev/null 2>&1 && exec bun "$1" "$2"
command -v node >/dev/null 2>&1 && exec node "$1" "$2"
exec "$BASH" -lc '
command -v bun >/dev/null 2>&1 && exec bun "$0" "$1"
command -v node >/dev/null 2>&1 && exec node "$0" "$1"
echo "{\\"error\\":{\\"code\\":\\"runtime_unavailable\\",\\"message\\":\\"The search needs Bun or Node.js.\\"}}" >&2
exit 2' "$1" "$2"`
