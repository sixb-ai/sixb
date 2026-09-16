import { MicrosoftProtocolError } from "./errors"
import { isRecord } from "./guards"
import type { MicrosoftHttp } from "./http"
import type { GraphPage, RequestOptions } from "./types/common"
import { graphUrl, httpsUrl, resource } from "./validation"

export function page<T extends { readonly id: string }>(value: unknown): GraphPage<T> {
  if (!isRecord(value) || !Array.isArray(value.value))
    throw new MicrosoftProtocolError("Graph returned a collection without a value array.")
  for (const item of value.value) resource(item)
  if (value["@odata.nextLink"] !== undefined) {
    if (typeof value["@odata.nextLink"] !== "string" || !value["@odata.nextLink"])
      throw new MicrosoftProtocolError("Graph returned an invalid nextLink.")
    graphUrl(httpsUrl(value["@odata.nextLink"]).href)
  }
  return value as unknown as GraphPage<T>
}

export async function* allPages<T extends { readonly id: string }>(
  http: MicrosoftHttp,
  initial: string,
  options?: RequestOptions,
  headers?: HeadersInit
): AsyncIterable<T> {
  let url: string | undefined = initial
  const visited = new Set<string>()
  while (url) {
    const canonical = graphUrl(url)
    if (visited.has(canonical))
      throw new MicrosoftProtocolError("Graph pagination repeated a nextLink.")
    visited.add(canonical)
    const result: GraphPage<T> = page(await http.json(url, { signal: options?.signal, headers }))
    yield* result.value
    url = result["@odata.nextLink"]
  }
}
