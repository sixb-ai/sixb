import type { ApiClient, HttpMethod } from "../api-client"
import { isHelp, parseCommandArgs, requestsHelp } from "../arguments"
import { fail, writeJson, writeRequestResult, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { readJson } from "./shared"

const METHODS = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])

/**
 * `sixb api <METHOD> <path>`: direct request against any relative `/api/...` route through the
 * active connection, auth, Unix socket, and grant boundary. Never accepts another origin or custom
 * authorization headers.
 */
export async function apiCommand(client: ApiClient, args: readonly string[]): Promise<void> {
  if (args.length === 0 || isHelp(args[0]) || requestsHelp(args)) {
    return writeText(GROUP_HELP.api)
  }

  const { positionals, options } = parseCommandArgs(
    args,
    {
      "--file": "string",
      "--input": "string",
      "--query": "strings",
      "--json": "boolean",
    },
    "api",
    2
  )

  const rawMethod = (positionals[0] ?? "").toUpperCase() as HttpMethod
  if (!METHODS.has(rawMethod)) {
    fail(
      `Unsupported HTTP method '${positionals[0] ?? ""}'. Use GET, POST, PUT, PATCH, DELETE, or HEAD.`
    )
  }
  const path = positionals[1] ?? ""
  if (options["--file"] && options["--input"]) {
    fail("--file and --input cannot be used together.")
  }

  let body: unknown
  if (options["--file"]) {
    body = await readJson(options["--file"])
  } else if (options["--input"] !== undefined) {
    try {
      body = JSON.parse(options["--input"])
    } catch {
      fail("--input must be valid JSON.", "invalid_json")
    }
  }
  if (body !== undefined && (rawMethod === "GET" || rawMethod === "HEAD")) {
    fail(`${rawMethod} requests cannot include a body.`)
  }

  const query = parseQueryPairs(options["--query"])
  const result = await client.request(rawMethod, path, {
    ...(query ? { query } : {}),
    ...(body === undefined ? {} : { body }),
  })
  if (rawMethod === "POST" || rawMethod === "PUT" || rawMethod === "PATCH") {
    return writeRequestResult(result)
  }
  writeJson(result)
}

function parseQueryPairs(
  entries: readonly string[] | undefined
): Record<string, string> | undefined {
  if (!entries || entries.length === 0) return undefined
  const query: Record<string, string> = {}
  for (const entry of entries) {
    const separator = entry.indexOf("=")
    if (separator <= 0) {
      fail(`Invalid --query '${entry}'. Use key=value.`)
    }
    query[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  return query
}
