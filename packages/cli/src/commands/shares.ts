import type { ApiClient } from "../api-client"
import { isHelp, parseCommandArgs, requestsHelp } from "../arguments"
import { formatShortDate, renderKeyValues, renderOutput, renderTable } from "../format"
import { fail, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { asRecord, idSegment, readJson } from "./shared"

export async function shares(api: ApiClient, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || requestsHelp(rest)) return writeText(GROUP_HELP.shares)

  if (sub === "list") {
    const { options } = parseCommandArgs(
      rest,
      { "--definition": "string", "--primary-id": "string", "--json": "boolean" },
      "shares list"
    )
    const result = asRecord(
      await api.get("/api/share-grants", {
        ...(options["--definition"] ? { definitionId: options["--definition"] } : {}),
        ...(options["--primary-id"] ? { primaryId: options["--primary-id"] } : {}),
      })
    )
    const grants = Array.isArray(result.grants) ? result.grants.map(asRecord) : []
    return renderOutput(result, {
      json: options["--json"],
      renderText: () =>
        renderTable({
          subtitle: `${grants.length} visible`,
          headers: ["ID", "Definition", "Destination", "Status", "Expires"],
          rows: grants.map((grant) => [
            String(grant.id ?? ""),
            String(grant.definitionId ?? ""),
            String(grant.destinationPath ?? ""),
            String(grant.status ?? ""),
            formatShortDate(grant.expiresAt),
          ]),
          emptyMessage: "No shared-access grants.",
        }),
    })
  }

  if (sub === "create") {
    const { options } = parseCommandArgs(
      rest,
      { "--file": "string", "--json": "boolean" },
      "shares create"
    )
    if (!options["--file"]) {
      fail("shares create requires --file <path|-> with the share grant payload.")
    }
    const payload = await readJson(options["--file"])
    const result = asRecord(await api.post("/api/share-grants", payload))
    const grant = asRecord(result.grant)
    return renderOutput(result, {
      json: options["--json"],
      renderText: () =>
        renderKeyValues({
          title: "Created shared-access grant",
          titleTone: "green",
          items: [
            { label: "ID", value: String(grant.id ?? "") },
            { label: "Definition", value: String(grant.definitionId ?? "") },
            { label: "Expires", value: formatShortDate(grant.expiresAt) },
            { label: "URL", value: String(result.url ?? "") },
          ],
        }),
    })
  }

  if (sub === "revoke") {
    const { positionals, options } = parseCommandArgs(
      rest,
      { "--json": "boolean" },
      "shares revoke",
      1
    )
    const grantId = positionals[0]?.trim() ?? ""
    const result = asRecord(await api.delete(`/api/share-grants/${idSegment(grantId)}`))
    return renderOutput(result, {
      json: options["--json"],
      renderText: () =>
        renderKeyValues({
          title: "Revoked shared-access grant",
          items: [{ label: "ID", value: grantId }],
        }),
    })
  }

  fail(`Unknown shares command '${sub}'. Run 'sixb shares --help'.`)
}
