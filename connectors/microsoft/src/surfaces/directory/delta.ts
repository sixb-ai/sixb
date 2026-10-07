import { MicrosoftConfigurationError, MicrosoftProtocolError } from "../../errors"
import { isRecord } from "../../guards"
import type { MicrosoftHttp } from "../../http"
import { page } from "../../pagination"
import type { DirectoryDeltaPage, OrgContact, OrgContactDeltaOptions } from "../../types/directory"
import { graphUrl, httpsUrl, nonEmpty, odataString, query } from "../../validation"

export interface OrgContactDeltaResource {
  list(options?: OrgContactDeltaOptions): Promise<DirectoryDeltaPage<OrgContact>>
  pages(options?: OrgContactDeltaOptions): AsyncIterable<DirectoryDeltaPage<OrgContact>>
}
function path(options?: OrgContactDeltaOptions): string {
  for (const key of ["top", "filter", "orderBy", "expand", "search"])
    if (options && key in options)
      throw new MicrosoftConfigurationError(`Organizational contact delta does not support ${key}.`)
  if (options?.cursor !== undefined) {
    if (options.select !== undefined || options.ids !== undefined || options.latest)
      throw new MicrosoftConfigurationError(
        "A delta cursor cannot be combined with select, ids or latest."
      )
    return graphUrl(httpsUrl(options.cursor).href)
  }
  const params = new URLSearchParams(query(options).slice(1))
  if (options?.ids !== undefined) {
    if (!Array.isArray(options.ids) || !options.ids.length || options.ids.length > 50)
      throw new MicrosoftConfigurationError("Delta ids must contain 1–50 contact IDs.")
    // The only filter Graph supports on directory delta: up to 50 objects by ID.
    params.set(
      "$filter",
      options.ids.map((id) => `id eq ${odataString(nonEmpty(id, "contact id"))}`).join(" or ")
    )
  }
  if (options?.latest) params.set("$deltatoken", "latest")
  return `contacts/delta${params.size ? `?${params}` : ""}`
}
const headers = (options?: OrgContactDeltaOptions): HeadersInit | undefined =>
  options?.minimal ? { Prefer: "return=minimal" } : undefined

export function orgContactDeltaResource(http: MicrosoftHttp): OrgContactDeltaResource {
  const list = async (options?: OrgContactDeltaOptions) => {
    const value = await http.json(path(options), {
      headers: headers(options),
      signal: options?.signal,
    })
    page(value)
    if (!isRecord(value)) throw new MicrosoftProtocolError("Invalid directory delta response.")
    const next = value["@odata.nextLink"]
    const delta = value["@odata.deltaLink"]
    if (
      (next !== undefined) === (delta !== undefined) ||
      (delta !== undefined && (typeof delta !== "string" || !delta))
    )
      throw new MicrosoftProtocolError(
        "Directory delta must return exactly one nextLink or deltaLink."
      )
    graphUrl(httpsUrl(String(next ?? delta)).href)
    return value as unknown as DirectoryDeltaPage<OrgContact>
  }
  return {
    list,
    async *pages(options) {
      let current = options
      const visited = new Set<string>()
      for (;;) {
        const url = graphUrl(path(current))
        if (visited.has(url))
          throw new MicrosoftProtocolError("Directory delta repeated a nextLink.")
        visited.add(url)
        const result = await list(current)
        yield result
        const cursor = result["@odata.nextLink"]
        if (!cursor) return
        current = { cursor, signal: options?.signal, minimal: options?.minimal }
      }
    },
  }
}
