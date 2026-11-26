import type { ApiClient } from "../api-client"
import { integerInRange, isHelp, parseCommandArgs, requestsHelp, rfc3339Value } from "../arguments"
import { fail, writeJson, writeText } from "../output"
import { CLI_LIMITS } from "../policies"
import { GROUP_HELP } from "./metadata"
import { idSegment } from "./shared"

export async function logs(api: ApiClient, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || requestsHelp(rest)) return writeText(GROUP_HELP.logs)

  if (sub === "list") {
    const { options } = parseCommandArgs(
      rest,
      {
        "--limit": "string",
        "--level": "string",
        "--service": "string",
        "--search": "string",
        "--from": "string",
        "--to": "string",
      },
      "logs list"
    )
    const limit =
      options["--limit"] === undefined
        ? undefined
        : String(integerInRange("--limit", options["--limit"], 1, CLI_LIMITS.list.maximum))
    return writeJson(
      await api.get("/api/logs", {
        ...(limit ? { limit } : {}),
        ...(options["--level"] ? { level: options["--level"] } : {}),
        ...(options["--service"] ? { service: options["--service"] } : {}),
        ...(options["--search"] ? { search: options["--search"] } : {}),
        ...(options["--from"] ? { from: rfc3339Value("--from", options["--from"]) } : {}),
        ...(options["--to"] ? { to: rfc3339Value("--to", options["--to"]) } : {}),
      })
    )
  }

  fail(`Unknown logs command '${sub}'. Run 'sixb logs --help'.`)
}

export async function activity(api: ApiClient, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || requestsHelp(rest)) return writeText(GROUP_HELP.activity)

  if (sub === "summary" || sub === "visits" || sub === "users") {
    const { options } = parseCommandArgs(
      rest,
      { "--from": "string", "--to": "string", "--limit": "string" },
      `activity ${sub}`
    )
    const limit =
      options["--limit"] === undefined
        ? undefined
        : String(integerInRange("--limit", options["--limit"], 1, CLI_LIMITS.list.maximum))
    return writeJson(
      await api.get(`/api/activity/${sub}`, {
        ...(options["--from"] ? { from: rfc3339Value("--from", options["--from"]) } : {}),
        ...(options["--to"] ? { to: rfc3339Value("--to", options["--to"]) } : {}),
        ...(limit ? { limit } : {}),
      })
    )
  }

  fail(`Unknown activity command '${sub}'. Run 'sixb activity --help'.`)
}

export async function connectors(api: ApiClient, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || requestsHelp(rest)) return writeText(GROUP_HELP.connectors)

  if (sub === "accounts") {
    const { positionals } = parseCommandArgs(rest, {}, "connectors accounts", 1)
    return writeJson(await api.get(`/api/connectors/${idSegment(positionals[0]?.trim())}/accounts`))
  }

  fail(`Unknown connectors command '${sub}'. Run 'sixb connectors --help'.`)
}
