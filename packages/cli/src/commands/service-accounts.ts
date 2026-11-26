import type { ApiClient } from "../api-client"
import { isHelp, parseCommandArgs, requestsHelp } from "../arguments"
import {
  formatGroups,
  formatShortDate,
  renderKeyValues,
  renderOutput,
  renderTable,
} from "../format"
import { fail, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { asRecord, idSegment } from "./shared"
import { assertNotAccessToken, normalizeGroupIds, resolveExpiration } from "./tokens"

export async function serviceAccounts(api: ApiClient, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || requestsHelp(rest)) return writeText(GROUP_HELP["service-accounts"])

  if (sub === "list") {
    const { options } = parseCommandArgs(rest, { "--json": "boolean" }, "service-accounts list")
    const result = asRecord(await api.get("/api/auth/service-accounts"))
    const items = Array.isArray(result.serviceAccounts) ? result.serviceAccounts.map(asRecord) : []
    return renderOutput(result, {
      json: options["--json"],
      renderText: () =>
        renderTable({
          subtitle: `${items.length} visible`,
          headers: ["Name", "ID", "Status", "Groups", "Updated"],
          rows: items.map((sa) => [
            String(sa.name ?? ""),
            String(sa.id ?? ""),
            String(sa.status ?? ""),
            formatGroups(sa.groupIds),
            formatShortDate(sa.updatedAt),
          ]),
          emptyMessage: "No service accounts.",
        }),
    })
  }

  if (sub === "create") {
    const { positionals, options } = parseCommandArgs(
      rest,
      {
        "--id": "string",
        "--name": "string",
        "--description": "string",
        "--group": "strings",
        "--json": "boolean",
      },
      "service-accounts create",
      [0, 1]
    )
    const name = options["--name"]?.trim() || positionals[0]?.trim()
    if (!name) fail("Usage: sixb service-accounts create <name> [--id <id>] [--group <id>]")
    const groupIds = normalizeGroupIds(options["--group"])
    const result = asRecord(
      await api.post("/api/auth/service-accounts", {
        ...(options["--id"]?.trim() ? { id: options["--id"].trim() } : {}),
        name,
        ...(options["--description"]?.trim()
          ? { description: options["--description"].trim() }
          : {}),
        ...(groupIds.length > 0 ? { groupIds } : {}),
      })
    )
    const sa = asRecord(result.serviceAccount)
    return renderOutput(result, {
      json: options["--json"],
      renderText: () =>
        renderKeyValues({
          title: "Created service account",
          titleTone: "green",
          items: [
            { label: "Name", value: String(sa.name ?? "") },
            { label: "ID", value: String(sa.id ?? "") },
            { label: "Status", value: String(sa.status ?? "") },
            { label: "Groups", value: formatGroups(sa.groupIds) },
          ],
        }),
    })
  }

  if (sub === "disable") {
    const { positionals, options } = parseCommandArgs(
      rest,
      { "--id": "string", "--json": "boolean" },
      "service-accounts disable",
      [0, 1]
    )
    const id = options["--id"]?.trim() || positionals[0]?.trim()
    if (!id) fail("Usage: sixb service-accounts disable <service-account-id>")
    const result = asRecord(
      await api.post(`/api/auth/service-accounts/${idSegment(id)}/disable`, {})
    )
    const sa = asRecord(result.serviceAccount)
    return renderOutput(result, {
      json: options["--json"],
      renderText: () =>
        renderKeyValues({
          title: "Disabled service account",
          items: [
            { label: "Name", value: String(sa.name ?? "") },
            { label: "ID", value: String(sa.id ?? "") },
            { label: "Status", value: String(sa.status ?? "") },
          ],
        }),
    })
  }

  if (sub === "tokens" || sub === "token") {
    return serviceAccountTokens(api, rest)
  }

  fail(`Unknown service-accounts command '${sub}'. Run 'sixb service-accounts --help'.`)
}

async function serviceAccountTokens(api: ApiClient, args: readonly string[]): Promise<void> {
  const [action, ...rest] = args
  if (!action || isHelp(action) || requestsHelp(rest)) {
    return writeText(GROUP_HELP["service-accounts"])
  }

  if (action === "list") {
    const { positionals, options } = parseCommandArgs(
      rest,
      { "--json": "boolean" },
      "service-accounts tokens list",
      1
    )
    const saId = positionals[0]?.trim() ?? ""
    const result = asRecord(
      await api.get(`/api/auth/service-accounts/${idSegment(saId)}/access-tokens`)
    )
    const items = Array.isArray(result.accessTokens) ? result.accessTokens.map(asRecord) : []
    return renderOutput(result, {
      json: options["--json"],
      renderText: () =>
        renderTable({
          subtitle: saId,
          headers: ["Name", "ID", "Status", "Groups", "Last used", "Expires"],
          rows: items.map((token) => [
            String(token.name ?? ""),
            String(token.id ?? ""),
            String(token.status ?? ""),
            formatGroups(token.groupIds),
            formatShortDate(token.lastUsedAt),
            formatShortDate(token.expiresAt),
          ]),
          emptyMessage: "No service-account tokens.",
        }),
    })
  }

  if (action === "create") {
    const { positionals, options } = parseCommandArgs(
      rest,
      {
        "--name": "string",
        "--expires-at": "string",
        "--expires-in": "string",
        "--group": "strings",
        "--json": "boolean",
      },
      "service-accounts tokens create",
      [1, 2]
    )
    const saId = positionals[0]?.trim() ?? ""
    const name = options["--name"]?.trim() || positionals[1]?.trim()
    if (!name) {
      fail("Usage: sixb service-accounts tokens create <service-account-id> <name> [options]")
    }
    assertNotAccessToken(api)
    const expiresAt = resolveExpiration(options["--expires-at"], options["--expires-in"])
    const groupIds = normalizeGroupIds(options["--group"])

    const result = asRecord(
      await api.post(`/api/auth/service-accounts/${idSegment(saId)}/access-tokens`, {
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
          title: "Created service-account token",
          titleTone: "green",
          subtitle: saId,
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

  if (action === "revoke") {
    const { positionals, options } = parseCommandArgs(
      rest,
      { "--id": "string", "--json": "boolean" },
      "service-accounts tokens revoke",
      [1, 2]
    )
    const saId = positionals[0]?.trim() ?? ""
    const tokenId = options["--id"]?.trim() || positionals[1]?.trim()
    if (!tokenId) {
      fail("Usage: sixb service-accounts tokens revoke <service-account-id> <token-id>")
    }
    const result = asRecord(
      await api.post(
        `/api/auth/service-accounts/${idSegment(saId)}/access-tokens/${idSegment(tokenId)}/revoke`,
        {}
      )
    )
    const token = asRecord(result.accessToken)
    return renderOutput(result, {
      json: options["--json"],
      renderText: () =>
        renderKeyValues({
          title: "Revoked service-account token",
          subtitle: saId,
          items: [
            { label: "Name", value: String(token.name ?? "") },
            { label: "ID", value: String(token.id ?? "") },
            { label: "Status", value: String(token.status ?? "") },
          ],
        }),
    })
  }

  fail(`Unknown service-accounts tokens command '${action}'. Run 'sixb service-accounts --help'.`)
}
