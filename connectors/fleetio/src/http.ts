import {
  type RestClient,
  type RestQueryParams,
  readResponseBody,
  withQuery,
} from "@sixb/connector-rest"
import { FleetioApiError } from "./errors"
import type { FleetioRequestMethod } from "./types"

export interface FleetioPostOptions {
  /** Mark a POST that only reads, so the default retry policy treats it as a read. */
  readonly idempotent?: boolean
}

export interface FleetioHttp {
  get<T>(path: string, query?: RestQueryParams): Promise<T>
  post<T>(path: string, body?: unknown, options?: FleetioPostOptions): Promise<T>
  put<T>(path: string, body?: unknown): Promise<T>
  patch<T>(path: string, body?: unknown): Promise<T>
  delete(path: string): Promise<void>
}

export function createFleetioHttp(rest: RestClient): FleetioHttp {
  async function request<T>(
    method: FleetioRequestMethod,
    path: string,
    body?: unknown,
    idempotent = method === "GET"
  ): Promise<T> {
    const response = await rest.request(path, { method, body }, { idempotent })
    const responseBody = await readResponseBody(response)
    if (!response.ok) {
      throw new FleetioApiError(response.status, responseBody, response.headers)
    }

    return responseBody as T
  }

  return {
    get<T>(path: string, query?: RestQueryParams) {
      return request<T>("GET", withQuery(path, query))
    },
    post<T>(path: string, body?: unknown, options?: FleetioPostOptions) {
      return request<T>("POST", path, body, options?.idempotent ?? false)
    },
    put<T>(path: string, body?: unknown) {
      return request<T>("PUT", path, body)
    },
    patch<T>(path: string, body?: unknown) {
      return request<T>("PATCH", path, body)
    },
    async delete(path: string) {
      await request<unknown>("DELETE", path)
    },
  }
}
