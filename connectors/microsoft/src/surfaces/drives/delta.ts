import { MicrosoftConfigurationError, MicrosoftProtocolError } from "../../errors"
import { isRecord } from "../../guards"
import type { MicrosoftHttp } from "../../http"
import { page } from "../../pagination"
import type { DeltaOptions, DeltaPage } from "../../types/files"
import { graphUrl, httpsUrl, query } from "../../validation"
import { drivePath } from "./paths"

export interface DriveDeltaResource {
  list(driveId: string, options?: DeltaOptions): Promise<DeltaPage>
  /** Yields whole pages so the consumer can durably commit each page and its checkpoint. */
  pages(driveId: string, options?: DeltaOptions): AsyncIterable<DeltaPage>
}

function deltaPath(driveId: string, options?: DeltaOptions): string {
  const base = `${drivePath(driveId)}/root/delta`
  if (options?.cursor !== undefined) {
    if (options.token || options.select || options.expand || options.top !== undefined)
      throw new MicrosoftConfigurationError(
        "A delta cursor cannot be combined with new query options."
      )
    // Graph owns this opaque URL, including possible alternate OData path syntax.
    // The caller must pair a saved cursor with the same drive and local state.
    return graphUrl(httpsUrl(options.cursor).href)
  }
  if (options?.token !== undefined && options.token !== "latest")
    throw new MicrosoftConfigurationError(
      "token must be latest; use cursor for stored delta links."
    )
  const suffix = query(options)
  return `${base}${suffix}${options?.token ? `${suffix ? "&" : "?"}token=latest` : ""}`
}

export function deltaResource(http: MicrosoftHttp): DriveDeltaResource {
  const delta: DriveDeltaResource = {
    async list(driveId, options) {
      const body = await http.json(deltaPath(driveId, options), { signal: options?.signal })
      page(body)
      if (!isRecord(body)) throw new MicrosoftProtocolError("Invalid delta response.")
      const next = body["@odata.nextLink"]
      const checkpoint = body["@odata.deltaLink"]
      if (
        (next !== undefined) === (checkpoint !== undefined) ||
        (checkpoint !== undefined && (typeof checkpoint !== "string" || !checkpoint))
      ) {
        throw new MicrosoftProtocolError("Delta must return exactly one nextLink or deltaLink.")
      }
      deltaPath(driveId, { cursor: String(next ?? checkpoint) })
      return body as unknown as DeltaPage
    },
    async *pages(driveId, options) {
      let current = options
      const visited = new Set<string>()
      for (;;) {
        const path = graphUrl(deltaPath(driveId, current))
        if (visited.has(path)) throw new MicrosoftProtocolError("Graph delta repeated a nextLink.")
        visited.add(path)
        const result = await delta.list(driveId, current)
        yield result
        if (!result["@odata.nextLink"]) return
        current = { cursor: result["@odata.nextLink"], signal: options?.signal }
      }
    },
  }
  return delta
}
