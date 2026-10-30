import type { ApiClient } from "../api-client"
import {
  enumValue,
  integerInRange,
  isHelp,
  nonNegativeInteger,
  parseCommandArgs,
  requestsHelp,
} from "../arguments"
import { CliError, EXIT_API, fail, writeJson, writeText } from "../output"
import { CLI_LIMITS } from "../policies"
import { GROUP_HELP } from "./metadata"
import type { QueryOptions } from "./shared"

const USER_STATUSES = ["active", "suspended", "all"] as const

const LIST_FLAGS = {
  "--status": "string",
  "--limit": "string",
  "--offset": "string",
} as const

export async function users(api: ApiClient, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || requestsHelp(rest)) return writeText(GROUP_HELP.users)

  if (sub === "get") {
    const { positionals } = parseCommandArgs(rest, {}, "users get", 1)
    const user = positionals[0]?.trim()
    if (!user) fail("users get requires a user id or email.")
    // Sign-in mints ids as `usr_<uuid>`, so an `@` marks an email.
    if (!user.includes("@")) {
      return writeJson(await api.get(`/api/users/${encodeURIComponent(user)}`))
    }

    const page = await api.get("/api/users", { email: user })
    const [member] = isRecord(page) && Array.isArray(page.users) ? page.users : []
    if (member === undefined) {
      throw new CliError(
        { code: "not_found", message: `No member has the email '${user}'.` },
        EXIT_API
      )
    }
    return writeJson(member)
  }

  if (sub === "list") {
    const { options } = parseCommandArgs(rest, LIST_FLAGS, "users list")
    return writeJson(await api.get("/api/users", listQuery(options)))
  }

  if (sub === "search") {
    const { positionals, options } = parseCommandArgs(rest, LIST_FLAGS, "users search", 1)
    const search = positionals[0]?.trim()
    if (!search) fail("users search requires the text to find in a name or email.")

    return writeJson(await api.get("/api/users", { ...listQuery(options), search }))
  }

  fail(`Unknown users command '${sub}'.`)
}

function listQuery(options: {
  readonly "--status"?: string
  readonly "--limit"?: string
  readonly "--offset"?: string
}): QueryOptions {
  const limit = integerInRange(
    "--limit",
    options["--limit"] ?? String(CLI_LIMITS.users.default),
    1,
    CLI_LIMITS.users.maximum
  )

  return {
    status: enumValue("--status", options["--status"] ?? "active", USER_STATUSES),
    limit: String(limit),
    ...(options["--offset"] === undefined
      ? {}
      : { offset: String(nonNegativeInteger("--offset", options["--offset"])) }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
