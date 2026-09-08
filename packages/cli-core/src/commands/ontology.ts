import type { ApiClient } from "../api-client"
import { isHelp, parseCommandArgs, requestsHelp } from "../arguments"
import { fail, writeJson, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { asRecord, asRecords } from "./shared"

export async function ontology(api: ApiClient, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub)) return writeText(GROUP_HELP.ontology)
  if (sub === "list") {
    if (requestsHelp(rest)) return writeText("Usage: sixb ontology list [--full]")
    const { options } = parseCommandArgs(rest, { "--full": "boolean" }, "ontology list")
    const full = options["--full"] ?? false
    const value = await api.get("/api/object-types")
    if (full) return writeJson(value)
    if (!Array.isArray(value)) fail("The ontology API returned an invalid response.")
    return writeJson(
      value.map((entry) => {
        const type = asRecord(entry)
        const properties = asRecords(type.properties)
        return {
          id: type.id,
          name: type.name,
          description: type.description,
          primaryPropertyId: properties.find((property) => property.primary === true)?.id,
          links: asRecords(type.links).map(
            ({ id, name, description, targetObjectTypeId, cardinality }) => ({
              id,
              name,
              ...(description === undefined ? {} : { description }),
              targetObjectTypeId,
              cardinality,
            })
          ),
          actions: asRecords(type.actions).map(({ id, name, description }) => ({
            id,
            name,
            ...(description === undefined ? {} : { description }),
          })),
        }
      })
    )
  }
  if (sub === "get") {
    if (requestsHelp(rest)) return writeText("Usage: sixb ontology get <object-type>")
    const { positionals } = parseCommandArgs(rest, {}, "ontology get", 1)
    return writeJson(await api.get(`/api/object-types/${encodeURIComponent(positionals[0] ?? "")}`))
  }
  fail(`Unknown ontology command '${sub}'.`)
}
