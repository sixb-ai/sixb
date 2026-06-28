import type { RestClient } from "@sixb/connector-rest"
import { PandaDocApiError } from "./errors"
import type { QueryParams, QueryValue } from "./types"

export interface PandaDocHttp {
  get<T>(path: string, query?: QueryParams): Promise<T>
  post<T>(path: string, body?: unknown, query?: QueryParams): Promise<T>
  patch<T>(path: string, body?: unknown, query?: QueryParams): Promise<T>
  put<T>(path: string, body?: unknown, query?: QueryParams): Promise<T>
  delete<T = void>(path: string, query?: QueryParams, body?: unknown): Promise<T>
  getRaw(path: string, query?: QueryParams): Promise<Response>
}

export function createPandaDocHttp(rest: RestClient): PandaDocHttp {
  return {
    async get<T>(path: string, query?: QueryParams): Promise<T> {
      return readJson<T>(await rest.get(withQuery(path, query)))
    },
    async post<T>(path: string, body?: unknown, query?: QueryParams): Promise<T> {
      return readJson<T>(await requestWithBody(rest, "POST", path, body, query))
    },
    async patch<T>(path: string, body?: unknown, query?: QueryParams): Promise<T> {
      return readJson<T>(await requestWithBody(rest, "PATCH", path, body, query))
    },
    async put<T>(path: string, body?: unknown, query?: QueryParams): Promise<T> {
      return readJson<T>(await requestWithBody(rest, "PUT", path, body, query))
    },
    async delete<T = void>(path: string, query?: QueryParams, body?: unknown): Promise<T> {
      return readJson<T>(await requestWithBody(rest, "DELETE", path, body, query))
    },
    async getRaw(path: string, query?: QueryParams): Promise<Response> {
      const response = await rest.get(withQuery(path, query))
      if (!response.ok) {
        throw await toError(response)
      }
      return response
    },
  }
}

export function withQuery(path: string, query?: QueryParams): string {
  const normalizedPath = normalizePath(path)
  if (!query) {
    return normalizedPath
  }

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    appendQueryParam(params, key, value)
  }

  const queryString = params.toString()
  if (!queryString) {
    return normalizedPath
  }

  return normalizedPath.includes("?")
    ? `${normalizedPath}&${queryString}`
    : `${normalizedPath}?${queryString}`
}

export function pathPart(value: string | number, field: string): string {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`[SixbPandaDoc] ${field} must be a positive integer.`)
    }
    return String(value)
  }

  if (!value.trim()) {
    throw new Error(`[SixbPandaDoc] ${field} must not be empty.`)
  }

  return encodeURIComponent(value)
}

async function requestWithBody(
  rest: RestClient,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body: unknown,
  query?: QueryParams
): Promise<Response> {
  const headers = new Headers()
  const init: RequestInit = { method, headers }
  const requestBody = serializeBody(body, headers)

  if (requestBody !== undefined) {
    init.body = requestBody
  }

  return rest.request(withQuery(path, query), init)
}

function serializeBody(body: unknown, headers: Headers): BodyInit | undefined {
  if (body === undefined) {
    return undefined
  }

  if (body === null) {
    headers.set("content-type", "application/json")
    return JSON.stringify(body)
  }

  if (
    typeof body === "string" ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof ReadableStream
  ) {
    return body as BodyInit
  }

  headers.set("content-type", "application/json")
  return JSON.stringify(body)
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw await toError(response)
  }

  return (await readResponseBody(response)) as T
}

async function toError(response: Response): Promise<PandaDocApiError> {
  return new PandaDocApiError(response.status, await readResponseBody(response), response.headers)
}

async function readResponseBody(response: Response): Promise<unknown> {
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

function appendQueryParam(params: URLSearchParams, key: string, value: QueryValue): void {
  if (value === undefined || value === "") {
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      params.append(key, String(item))
    }
    return
  }

  params.set(key, String(value))
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path
}
