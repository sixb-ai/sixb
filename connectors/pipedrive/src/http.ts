import type { RestClient } from "@sixb/connector-rest"
import { PipedriveApiError } from "./errors"
import type { QueryParams, QueryValue } from "./types"

export type PipedriveApiVersion = "v1" | "v2"

export interface PipedriveHttpClients {
  readonly v1: RestClient
  readonly v2: RestClient
}

export interface PipedriveHttp {
  get<T>(version: PipedriveApiVersion, path: string, query?: QueryParams): Promise<T>
}

export function createPipedriveHttp(clients: PipedriveHttpClients): PipedriveHttp {
  return {
    async get<T>(version: PipedriveApiVersion, path: string, query?: QueryParams): Promise<T> {
      return readJson<T>(await clients[version].get(withQuery(path, query)))
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
  return queryString ? `${normalizedPath}?${queryString}` : normalizedPath
}

export function pathPart(value: string | number, field: string): string {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`[SixbPipedrive] ${field} must be a positive integer.`)
    }
    return String(value)
  }

  if (!value.trim()) {
    throw new Error(`[SixbPipedrive] ${field} must not be empty.`)
  }

  return encodeURIComponent(value)
}

async function readJson<T>(response: Response): Promise<T> {
  const responseBody = await readResponseBody(response)
  if (!response.ok) {
    throw new PipedriveApiError(response.status, responseBody)
  }

  return responseBody as T
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
  if (value === undefined) {
    return
  }

  if (Array.isArray(value)) {
    if (value.length > 0) {
      params.set(key, value.map(String).join(","))
    }
    return
  }

  params.set(key, String(value))
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path
}
