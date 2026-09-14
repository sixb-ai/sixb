import { MicrosoftConfigurationError, MicrosoftProtocolError } from "./errors"
import { isRecord } from "./guards"
import type { ListOptions, SelectOptions } from "./types/common"

export function nonEmpty(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MicrosoftConfigurationError(`${name} must not be empty.`)
  }
  return value
}

export function segment(value: string, name = "id"): string {
  nonEmpty(value, name)
  if (value === "." || value === "..") {
    throw new MicrosoftConfigurationError(`${name} must not be a dot segment.`)
  }
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

export function fileName(value: string): string {
  nonEmpty(value, "name")
  if (/["*:<>?/\\|\u0000-\u001f]/.test(value) || /[. ]$/.test(value) || /^ /.test(value)) {
    throw new MicrosoftConfigurationError(
      "name must be a single valid SharePoint file or folder name."
    )
  }
  return segment(value, "name")
}

export function filePath(value: string): string {
  nonEmpty(value, "path")
  return value.split("/").map(fileName).join("/")
}

export function query(options?: SelectOptions | ListOptions): string {
  const params = new URLSearchParams()
  if (options?.select) {
    if (options.select.length === 0)
      throw new MicrosoftConfigurationError("select must not be empty.")
    // Keep the identity available even for projected responses and delta tombstones.
    params.set(
      "$select",
      [...new Set(["id", ...options.select.map((s) => nonEmpty(s, "select field"))])].join(",")
    )
  }
  if (options?.expand) params.set("$expand", options.expand)
  if (options && "top" in options && options.top !== undefined) {
    if (!Number.isSafeInteger(options.top) || options.top <= 0)
      throw new MicrosoftConfigurationError("top must be a positive integer.")
    params.set("$top", String(options.top))
  }
  if (options && "orderBy" in options && options.orderBy) params.set("$orderby", options.orderBy)
  return params.size ? `?${params}` : ""
}

export function httpsUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new MicrosoftProtocolError("Expected an absolute HTTPS URL.")
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port) {
    throw new MicrosoftProtocolError("Expected an HTTPS URL without credentials, port or fragment.")
  }
  return url
}

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0/"

export function graphUrl(path: string): string {
  const url = httpsUrl(new URL(path, GRAPH_BASE).href)
  if (url.origin !== "https://graph.microsoft.com" || !url.pathname.startsWith("/v1.0/")) {
    throw new MicrosoftProtocolError("Graph links must stay on https://graph.microsoft.com/v1.0/.")
  }
  return url.href
}

export function resource<T extends { readonly id: string }>(value: unknown): T {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) {
    throw new MicrosoftProtocolError("Graph returned a resource without an id.")
  }
  // Provider wire boundary. Individual optional properties retain Graph's response shape.
  return value as T
}
