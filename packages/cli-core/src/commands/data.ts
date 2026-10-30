import type { ApiClient } from "../api-client"
import {
  integerInRange,
  isHelp,
  nonNegativeInteger,
  parseCommandArgs,
  requestsHelp,
} from "../arguments"
import { fail, writeJson, writeText } from "../output"
import { CLI_LIMITS } from "../policies"
import { GROUP_HELP } from "./metadata"
import type { QueryOptions } from "./shared"

const segment = (value: string | undefined) => encodeURIComponent(value ?? "")

export async function datasets(api: ApiClient, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || requestsHelp(rest)) return writeText(GROUP_HELP.datasets)

  if (sub === "list") {
    parseCommandArgs(rest, {}, "datasets list")
    return writeJson(await api.get("/api/datasets"))
  }

  if (sub === "get") {
    const { positionals } = parseCommandArgs(rest, {}, "datasets get", 1)
    return writeJson(await api.get(`/api/datasets/${segment(positionals[0])}`))
  }

  if (sub === "versions") {
    const { positionals, options } = parseCommandArgs(
      rest,
      { "--limit": "string" },
      "datasets versions",
      1
    )
    const { default: fallback, maximum } = CLI_LIMITS.datasetVersions
    const limit = integerInRange("--limit", options["--limit"] ?? String(fallback), 1, maximum)
    return writeJson(
      await api.get(`/api/datasets/${segment(positionals[0])}/versions`, { limit: String(limit) })
    )
  }

  if (sub === "rows") {
    const { positionals, options } = parseCommandArgs(
      rest,
      { "--version": "string", "--columns": "string", "--limit": "string", "--offset": "string" },
      "datasets rows",
      1
    )
    const { default: fallback, maximum } = CLI_LIMITS.datasetRows
    const query: QueryOptions = {
      limit: String(integerInRange("--limit", options["--limit"] ?? String(fallback), 1, maximum)),
      ...(options["--version"] === undefined ? {} : { versionId: options["--version"] }),
      ...(options["--columns"] === undefined ? {} : { columns: columnList(options["--columns"]) }),
      ...(options["--offset"] === undefined
        ? {}
        : { offset: String(nonNegativeInteger("--offset", options["--offset"])) }),
    }
    return writeJson(await api.get(`/api/datasets/${segment(positionals[0])}/rows`, query))
  }

  fail(`Unknown datasets command '${sub}'.`)
}

/** `syncs` and `pipelines`: the definitions the caller may run, with each one's latest run. */
export async function runnables(
  api: ApiClient,
  group: "syncs" | "pipelines",
  args: readonly string[]
): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || requestsHelp(rest)) return writeText(GROUP_HELP[group])

  if (sub === "list") {
    parseCommandArgs(rest, {}, `${group} list`)
    return writeJson(await api.get(`/api/${group}`))
  }

  if (sub === "get") {
    const { positionals } = parseCommandArgs(rest, {}, `${group} get`, 1)
    return writeJson(await api.get(`/api/${group}/${segment(positionals[0])}`))
  }

  fail(`Unknown ${group} command '${sub}'.`)
}

function columnList(value: string): string {
  const columns = value.split(",").map((column) => column.trim())
  if (columns.some((column) => !column)) fail("--columns takes column names separated by commas.")
  return columns.join(",")
}
