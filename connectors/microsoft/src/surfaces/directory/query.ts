import { MicrosoftConfigurationError } from "../../errors"
import type { MicrosoftHttp } from "../../http"
import { allPages, page } from "../../pagination"
import type { DirectoryPage, DirectoryQueryOptions } from "../../types/directory"
import { nonEmpty, query } from "../../validation"

/** Query string and headers, including Graph's advanced-query mode when it is required. */
export function directoryRequest(
  options: DirectoryQueryOptions | undefined,
  advanced = options?.advancedQuery === true
): { readonly path: string; readonly headers?: HeadersInit } {
  const eventual = advanced || options?.search !== undefined
  if (eventual && options?.expand !== undefined)
    throw new MicrosoftConfigurationError("Graph does not support expand in advanced queries.")
  const params = new URLSearchParams(query(options).slice(1))
  if (options?.filter !== undefined) params.set("$filter", nonEmpty(options.filter, "filter"))
  if (options?.search !== undefined) params.set("$search", nonEmpty(options.search, "search"))
  if (advanced) params.set("$count", "true")
  return {
    path: params.size ? `?${params}` : "",
    ...(eventual ? { headers: { ConsistencyLevel: "eventual" } } : {}),
  }
}

export async function directoryList<T extends { id: string }>(
  http: MicrosoftHttp,
  path: string,
  options?: DirectoryQueryOptions,
  advanced?: boolean
): Promise<DirectoryPage<T>> {
  const request = directoryRequest(options, advanced)
  return page<T>(
    await http.json(`${path}${request.path}`, {
      headers: request.headers,
      signal: options?.signal,
    })
  )
}

export function directoryListAll<T extends { id: string }>(
  http: MicrosoftHttp,
  path: string,
  options?: DirectoryQueryOptions,
  advanced?: boolean
): AsyncIterable<T> {
  const request = directoryRequest(options, advanced)
  return allPages(http, `${path}${request.path}`, options, request.headers)
}
