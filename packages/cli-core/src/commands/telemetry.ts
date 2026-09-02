import type { ApiClient } from "../api-client"
import {
  enumValue,
  integerInRange,
  isHelp,
  requireExact,
  requireOrderedRange,
  rfc3339Value,
} from "../arguments"
import { fail, writeJson, writeText } from "../output"
import { CLI_LIMITS, DEFAULT_TELEMETRY_ORDER } from "../policies"
import { GROUP_HELP } from "./metadata"
import { normalizeWindowOptions, parseQueryOptions, readJson, singleFileOption } from "./shared"

export async function telemetry(api: ApiClient, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || isHelp(rest[0])) return writeText(GROUP_HELP.telemetry)
  if (sub === "latest") {
    requireExact(rest, 3, "telemetry latest requires object type, primary id, and property id.")
    return writeJson(await api.get(telemetryPath(rest, "latest")))
  }
  if (sub === "history") {
    if (rest.length < 3)
      fail("telemetry history requires object type, primary id, and property id.")
    const query = normalizeWindowOptions(
      parseQueryOptions(
        rest.slice(3),
        { "--from": "from", "--to": "to", "--limit": "limit", "--order": "order" },
        "telemetry history"
      ),
      {
        defaultLimit: CLI_LIMITS.telemetryHistory.default,
        maximumLimit: CLI_LIMITS.telemetryHistory.maximum,
        defaultOrder: DEFAULT_TELEMETRY_ORDER,
      }
    )
    if (query.from !== undefined) query.from = rfc3339Value("--from", query.from)
    if (query.to !== undefined) query.to = rfc3339Value("--to", query.to)
    requireOrderedRange("--from", query.from, "--to", query.to)
    return writeJson(await api.get(telemetryPath(rest, "history"), query))
  }
  if (sub === "query") {
    return writeJson(
      await api.post(
        "/api/telemetry/history",
        normalizeTelemetryQueryInput(await readJson(singleFileOption(rest, "telemetry query")))
      )
    )
  }
  fail(`Unknown telemetry command '${sub}'.`)
}

function telemetryPath(args: readonly string[], terminal: "latest" | "history"): string {
  return `/api/objects/${encodeURIComponent(args[0] ?? "")}/${encodeURIComponent(args[1] ?? "")}/telemetry/${encodeURIComponent(args[2] ?? "")}/${terminal}`
}

function normalizeTelemetryQueryInput(input: unknown): Record<string, unknown> {
  if (Array.isArray(input) || typeof input !== "object" || input === null) {
    fail("Telemetry query input must be a JSON object.")
  }
  const body = { ...input } as Record<string, unknown>
  const rawLimit = body.limitPerSeries
  if (rawLimit !== undefined && typeof rawLimit !== "number") {
    fail("limitPerSeries must be a number.")
  }
  body.limitPerSeries = integerInRange(
    "limitPerSeries",
    String(rawLimit ?? CLI_LIMITS.telemetryHistory.default),
    1,
    CLI_LIMITS.telemetryHistory.maximum
  )
  const rawOrder = body.order
  if (rawOrder !== undefined && typeof rawOrder !== "string") {
    fail("order must be a string.")
  }
  body.order = enumValue("order", rawOrder ?? DEFAULT_TELEMETRY_ORDER, ["asc", "desc"])
  for (const field of ["from", "to"] as const) {
    const value = body[field]
    if (value === undefined) continue
    if (typeof value !== "string") fail(`${field} must be an RFC 3339 timestamp.`)
    body[field] = rfc3339Value(field, value)
  }
  requireOrderedRange("from", body.from as string | undefined, "to", body.to as string | undefined)
  return body
}
