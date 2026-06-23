import type { RestClient } from "@sixb/connector-rest"
import { CompanyCamApiError } from "./errors"

export type QueryValue = string | number | boolean | readonly (string | number)[] | undefined
export type QueryParams = Readonly<Record<string, QueryValue>>

/**
 * Thin typed wrapper over the `@sixb/connector-rest` client.
 *
 * Resource modules use this so they stay tiny and uniform: it builds query
 * strings, serializes JSON bodies, parses responses, and throws
 * `CompanyCamApiError` on any non-2xx response.
 */
export interface Http {
  get<T>(path: string, query?: QueryParams): Promise<T>
  post<T>(path: string, body?: unknown): Promise<T>
  put<T>(path: string, body?: unknown): Promise<T>
  delete(path: string): Promise<void>
}

export function createHttp(rest: RestClient): Http {
  return {
    async get<T>(path: string, query?: QueryParams): Promise<T> {
      return readJson<T>(await rest.get(withQuery(path, query)))
    },
    async post<T>(path: string, body?: unknown): Promise<T> {
      return readJson<T>(await rest.post(path, body))
    },
    async put<T>(path: string, body?: unknown): Promise<T> {
      return readJson<T>(
        await rest.request(path, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
        })
      )
    },
    async delete(path: string): Promise<void> {
      const response = await rest.request(path, { method: "DELETE" })
      if (!response.ok) {
        throw await toError(response)
      }
    },
  }
}

function withQuery(path: string, query?: QueryParams): string {
  if (!query) {
    return path
  }

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(`${key}[]`, String(item))
      }
    } else {
      params.set(key, String(value))
    }
  }

  const queryString = params.toString()
  return queryString ? `${path}?${queryString}` : path
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw await toError(response)
  }
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

async function toError(response: Response): Promise<CompanyCamApiError> {
  return new CompanyCamApiError(response.status, await response.text().catch(() => ""))
}
