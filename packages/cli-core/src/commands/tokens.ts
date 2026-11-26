import type { ApiClient } from "../api-client"
import { isHelp, parseCommandArgs, requestsHelp } from "../arguments"
import {
  formatGroups,
  formatShortDate,
  renderKeyValues,
  renderOutput,
  renderTable,
} from "../format"
import { CliError, EXIT_USAGE, fail, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { asRecord, idSegment } from "./shared"

const DURATION_PATTERN = /^(\d+)([smhdwy])$/i
const DURATION_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
  y: 365 * 86_400_000,
}

export async function tokens(api: ApiClient, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || requestsHelp(rest)) return writeText(GROUP_HELP.tokens)

  if (sub === "list") {
    const { options } = parseCommandArgs(rest, { "--json": "boolean" }, "tokens list")
    const result = asRecord(await api.get("/api/auth/access-tokens"))
    const items = Array.isArray(result.accessTokens) ? result.accessTokens.map(asRecord) : []
    return renderOutput(result, {
      json: options["--json"],
      renderText: () =>
        renderTable({
          subtitle: `${items.length} visible`,
          headers: ["Name", "ID", "Status", "Groups", "Last used", "Expires"],
          rows: items.map((token) => [
            String(token.name ?? ""),
            String(token.id ?? ""),
            String(token.status ?? ""),
            formatGroups(token.groupIds),
            formatShortDate(token.lastUsedAt),
            formatShortDate(token.expiresAt),
          ]),
          emptyMessage: "No personal access tokens.",
        }),
    })
  }

  if (sub === "create") {
    const { positionals, options } = parseCommandArgs(
      rest,
      {
        "--name": "string",
        "--expires-at": "string",
        "--expires-in": "string",
        "--group": "strings",
        "--json": "boolean",
      },
      "tokens create",
      [0, 1]
    )
    const name = options["--name"]?.trim() || positionals[0]?.trim()
    if (!name) fail("Usage: sixb tokens create <name> [--expires-in 90d] [--group <id>]")
    assertNotAccessToken(api)
    const expiresAt = resolveExpiration(options["--expires-at"], options["--expires-in"])
    const groupIds = normalizeGroupIds(options["--group"])

    const result = asRecord(
      await api.post("/api/auth/access-tokens", {
        name,
        ...(expiresAt ? { expiresAt } : {}),
        ...(groupIds.length > 0 ? { groupIds } : {}),
      })
    )
    const token = asRecord(result.accessToken)
    const secret = typeof result.tokenValue === "string" ? result.tokenValue : ""
    return renderOutput(result, {
      json: options["--json"],
      renderText: () =>
        renderKeyValues({
          title: "Created personal access token",
          titleTone: "green",
          items: [
            { label: "Name", value: String(token.name ?? "") },
            { label: "ID", value: String(token.id ?? "") },
            { label: "Expires", value: formatShortDate(token.expiresAt) },
            { label: "Groups", value: formatGroups(token.groupIds) },
            { label: "Token", value: secret },
          ],
          note: "Copy this token now; it will not be shown again.",
        }),
    })
  }

  if (sub === "revoke") {
    const { positionals, options } = parseCommandArgs(
      rest,
      { "--id": "string", "--json": "boolean" },
      "tokens revoke",
      [0, 1]
    )
    const tokenId = options["--id"]?.trim() || positionals[0]?.trim()
    if (!tokenId) fail("Usage: sixb tokens revoke <token-id>")
    const result = asRecord(
      await api.post(`/api/auth/access-tokens/${idSegment(tokenId)}/revoke`, {})
    )
    const token = asRecord(result.accessToken)
    return renderOutput(result, {
      json: options["--json"],
      renderText: () =>
        renderKeyValues({
          title: "Revoked personal access token",
          items: [
            { label: "Name", value: String(token.name ?? "") },
            { label: "ID", value: String(token.id ?? "") },
            { label: "Status", value: String(token.status ?? "") },
          ],
        }),
    })
  }

  fail(`Unknown tokens command '${sub}'. Run 'sixb tokens --help'.`)
}

export function assertNotAccessToken(api: ApiClient): void {
  const token = api.bearerToken
  if (token && (token.startsWith("sixb_pat_") || token.startsWith("sixb_sat_"))) {
    throw new CliError(
      {
        code: "session_required",
        message: `Creating a token requires signing in; an access token cannot create another token. Run \`sixb login ${api.baseUrl}\`, then create the token from that profile.`,
      },
      EXIT_USAGE
    )
  }
}

export function resolveExpiration(
  expiresAt: string | undefined,
  expiresIn: string | undefined
): string | undefined {
  if (expiresAt && expiresIn) {
    fail("Use either --expires-at or --expires-in, not both.")
  }
  if (expiresAt) {
    const parsed = Date.parse(expiresAt)
    if (Number.isNaN(parsed)) fail(`Invalid --expires-at timestamp '${expiresAt}'.`)
    return new Date(parsed).toISOString()
  }
  if (!expiresIn) return undefined
  const match = DURATION_PATTERN.exec(expiresIn.trim())
  if (!match) fail(`Invalid --expires-in duration '${expiresIn}'. Use values like 30d, 12h, or 1y.`)
  const amount = Number.parseInt(match[1] ?? "0", 10)
  const unit = (match[2] ?? "").toLowerCase()
  const multiplier = DURATION_MS[unit]
  if (!multiplier || amount <= 0) fail(`Invalid --expires-in duration '${expiresIn}'.`)
  return new Date(Date.now() + amount * multiplier).toISOString()
}

export function normalizeGroupIds(values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) return []
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}
