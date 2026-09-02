import type { ApiClient } from "../api-client"
import { isHelp, requireExact } from "../arguments"
import { fail, writeJson, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { asRecord, asRecords } from "./shared"

export async function ontology(api: ApiClient, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub)) return writeText(GROUP_HELP.ontology)
  if (sub === "list") {
    if (isHelp(rest[0])) return writeText("Usage: sixb ontology list [--full]")
    const full = rest.length === 1 && rest[0] === "--full"
    if (!full && rest.length > 0) fail(`Unknown ontology list option '${rest[0]}'.`)
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
    if (isHelp(rest[0])) return writeText("Usage: sixb ontology get <object-type>")
    requireExact(rest, 1, "ontology get requires exactly one object type.")
    return writeJson(await api.get(`/api/object-types/${encodeURIComponent(rest[0] ?? "")}`))
  }
  fail(`Unknown ontology command '${sub}'.`)
}
