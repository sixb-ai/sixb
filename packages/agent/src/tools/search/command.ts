import {
  type GlobSearchRequest,
  type GrepSearchRequest,
  SearchError,
  type SearchRequest,
} from "./request"
import { globFiles, grepFiles } from "./search"

const USAGE = "Usage: search.mjs <request JSON>"

const KEYS: Readonly<Record<SearchRequest["tool"], readonly string[]>> = {
  glob: ["tool", "pattern", "path", "contextDirectory", "timeoutMs"],
  grep: ["tool", "pattern", "path", "include", "literal", "contextDirectory", "timeoutMs"],
}

/** What the process prints, and the code it exits with. */
export interface SearchCommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * `search.mjs '<request JSON>'`: the Agent's `glob` and `grep`, the same in every sandbox. The
 * request is one JSON argument, so no shell quoting reaches a pattern; the result is one JSON
 * line. A search that cannot run exits 2 with `{"error":{"code","message"}}` on stderr: a request
 * it does not understand is `invalid_arguments`, and a search the request names wrongly has its
 * own code ({@link SearchError}). Anything else exits 3, as `internal_error`.
 */
export async function runSearchCommand(
  args: readonly string[],
  workingDirectory: string
): Promise<SearchCommandResult> {
  try {
    const request = parseRequest(args)
    const result =
      request.tool === "glob"
        ? globFiles(request, workingDirectory)
        : await grepFiles(request, workingDirectory)

    return { exitCode: 0, stdout: `${JSON.stringify(result)}\n`, stderr: "" }
  } catch (error) {
    if (error instanceof SearchError) return failure(2, error.code, error.message)
    if (error instanceof RequestError) return failure(2, "invalid_arguments", error.message)

    const message = error instanceof Error ? error.message : "The search failed unexpectedly."
    return failure(3, "internal_error", message)
  }
}

class RequestError extends Error {}

function failure(exitCode: number, code: string, message: string): SearchCommandResult {
  return { exitCode, stdout: "", stderr: `${JSON.stringify({ error: { code, message } })}\n` }
}

function fail(message: string): never {
  throw new RequestError(message)
}

function parseRequest(args: readonly string[]): SearchRequest {
  if (args.length !== 1) fail(USAGE)

  let value: unknown
  try {
    value = JSON.parse(args[0] as string)
  } catch {
    fail("The search request is not valid JSON.")
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("The search request must be a JSON object.")
  }

  const input = value as Record<string, unknown>
  const tool = input.tool
  if (tool !== "glob" && tool !== "grep") fail("tool must be 'glob' or 'grep'.")
  for (const key of Object.keys(input)) {
    if (!KEYS[tool].includes(key)) fail(`The ${tool} request has an unknown property '${key}'.`)
  }

  const pattern = nonEmptyString(input.pattern, "pattern")
  const timeoutMs = input.timeoutMs
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    fail("timeoutMs must be a non-negative integer.")
  }
  const path = optionalString(input.path, "path")
  const contextDirectory = optionalString(input.contextDirectory, "contextDirectory")
  const scope = {
    timeoutMs,
    ...(path === undefined ? {} : { path }),
    ...(contextDirectory === undefined ? {} : { contextDirectory }),
  }

  if (tool === "glob") return { tool, pattern, ...scope } satisfies GlobSearchRequest

  if (input.literal !== undefined && typeof input.literal !== "boolean") {
    fail("literal must be true or false.")
  }
  const include = optionalString(input.include, "include")
  return {
    tool,
    pattern,
    ...scope,
    ...(include === undefined ? {} : { include }),
    ...(input.literal === undefined ? {} : { literal: input.literal }),
  } satisfies GrepSearchRequest
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") fail(`${field} must be a non-empty string.`)
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : nonEmptyString(value, field)
}
