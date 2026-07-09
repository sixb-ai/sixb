import type { RestClient } from "@sixb/connector-rest"
import { GoogleApiError } from "./errors"
import type { QueryParams } from "./types/common"

/**
 * The Google API surfaces this connector exposes. Adding a surface = add its
 * name here, a base URL in `google.ts`, its typed resources, and one wiring
 * line in `client.ts` — the auth and HTTP core below never change.
 */
export type GoogleSurface = "drive" | "calendar"

export type GoogleHttpClients = Record<GoogleSurface, RestClient>

/** Every HTTP verb the Google REST surfaces use. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

export interface GoogleRequestOptions {
  readonly query?: QueryParams
  readonly body?: unknown
}

export interface GoogleHttp {
  /** JSON request against a surface; throws `GoogleApiError` on non-2xx. */
  json<T>(
    surface: GoogleSurface,
    method: HttpMethod,
    path: string,
    options?: GoogleRequestOptions
  ): Promise<T>
  /** Raw bytes (e.g. Drive `files.export`); throws `GoogleApiError` on non-2xx. */
  media(
    surface: GoogleSurface,
    path: string,
    options?: { query?: QueryParams }
  ): Promise<Uint8Array>
}

export function createGoogleHttp(clients: GoogleHttpClients): GoogleHttp {
  return {
    async json<T>(
      surface: GoogleSurface,
      method: HttpMethod,
      path: string,
      options?: GoogleRequestOptions
    ): Promise<T> {
      const client = clients[surface]
      const url = withQuery(path, options?.query)
      // `post` serializes a JSON body and sets content-type under any verb;
      // `request` covers the bodiless verbs (GET/DELETE) without one.
      const response =
        method === "GET"
          ? await client.get(url)
          : method === "DELETE"
            ? await client.request(url, { method: "DELETE" })
            : await client.post(url, options?.body, { method })
      return readJson<T>(response)
    },

    async media(
      surface: GoogleSurface,
      path: string,
      options?: { query?: QueryParams }
    ): Promise<Uint8Array> {
      const response = await clients[surface].get(withQuery(path, options?.query))
      if (!response.ok) {
        throw new GoogleApiError(response.status, await readErrorBody(response))
      }
      return new Uint8Array(await response.arrayBuffer())
    },
  }
}

export function withQuery(path: string, query?: QueryParams): string {
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path
  if (!query) {
    return normalizedPath
  }

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value))
    }
  }

  const queryString = params.toString()
  return queryString ? `${normalizedPath}?${queryString}` : normalizedPath
}

/** Encode a required path segment, rejecting empty values early. */
export function pathSegment(value: string, field: string): string {
  if (!value.trim()) {
    throw new Error(`[SixbGoogle] ${field} must not be empty.`)
  }
  return encodeURIComponent(value)
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await readBody(response)
  if (!response.ok) {
    throw new GoogleApiError(response.status, body)
  }
  return body as T
}

async function readErrorBody(response: Response): Promise<unknown> {
  return readBody(response)
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined
  }
  const text = await response.text()
  if (!text) {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
