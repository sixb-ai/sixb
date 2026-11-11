import { isHelp } from "../arguments"
import { fail, writeJson, writeText } from "../output"
import {
  type GlobSearchRequest,
  type GrepSearchRequest,
  globFiles,
  grepFiles,
  SearchError,
  type SearchRequest,
} from "../search/search"

const USAGE = "Usage: sixb search <request JSON>"

const KEYS: Readonly<Record<SearchRequest["tool"], readonly string[]>> = {
  glob: ["tool", "pattern", "path", "contextDirectory", "timeoutMs"],
  grep: ["tool", "pattern", "path", "include", "literal", "contextDirectory", "timeoutMs"],
}

/**
 * `sixb search '<request JSON>'`: the Agent's `glob` and `grep`, the same in every sandbox. Not
 * in the help: the Agent calls it through its tools. The request is one JSON argument, so no
 * shell quoting reaches a pattern; the result is one JSON line on stdout.
 */
export function search(args: readonly string[]): void {
  if (isHelp(args[0])) {
    writeText(USAGE)
    return
  }
  if (args.length !== 1) fail(USAGE)

  const request = parseRequest(args[0] as string)
  try {
    writeJson(
      request.tool === "glob"
        ? globFiles(request, process.cwd())
        : grepFiles(request, process.cwd())
    )
  } catch (error) {
    if (error instanceof SearchError) fail(error.message, error.code)
    throw error
  }
}

function parseRequest(text: string): SearchRequest {
  let value: unknown
  try {
    value = JSON.parse(text)
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
