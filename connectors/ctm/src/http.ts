import {
  type RestClient,
  type RestQueryParams,
  readResponseBody,
  withQuery,
} from "@sixb/connector-rest"
import { CtmApiError } from "./errors"
import type { CtmRequestMethod } from "./types"

export interface CtmPostOptions {
  /** Mark a POST that only reads, so the default retry policy treats it as a read. */
  readonly idempotent?: boolean
}

export interface CtmHttp {
  get<T>(path: string, query?: RestQueryParams): Promise<T>
  post<T>(path: string, body?: unknown, options?: CtmPostOptions): Promise<T>
  put<T>(path: string, body?: unknown): Promise<T>
  patch<T>(path: string, body?: unknown): Promise<T>
  delete<T>(path: string, body?: unknown): Promise<T>
  /** The response itself, for a body that is not JSON such as a recording. */
  download(path: string): Promise<Response>
  /** Answers `true` on a 204 and `false` on any other success or a 404. */
  exists(path: string, query?: RestQueryParams): Promise<boolean>
}

export function createCtmHttp(rest: RestClient): CtmHttp {
  async function request<T>(
    method: CtmRequestMethod,
    path: string,
    body?: unknown,
    idempotent = method === "GET"
  ): Promise<T> {
    const response = await rest.request(path, { method, body }, { idempotent })
    const responseBody = await readResponseBody(response)

    if (!response.ok) {
      throw new CtmApiError(response.status, responseBody, response.headers)
    }

    return responseBody as T
  }

  return {
    get<T>(path: string, query?: RestQueryParams) {
      return request<T>("GET", toPath(path, query))
    },

    post<T>(path: string, body?: unknown, options?: CtmPostOptions) {
      return request<T>("POST", path, body, options?.idempotent ?? false)
    },

    put<T>(path: string, body?: unknown) {
      return request<T>("PUT", path, body)
    },

    patch<T>(path: string, body?: unknown) {
      return request<T>("PATCH", path, body)
    },

    delete<T>(path: string, body?: unknown) {
      return request<T>("DELETE", path, body)
    },

    async download(path: string) {
      const response = await rest.request(path, { method: "GET", headers: { Accept: "*/*" } })

      if (!response.ok) {
        throw new CtmApiError(response.status, await readResponseBody(response), response.headers)
      }

      return response
    },

    async exists(path: string, query?: RestQueryParams) {
      const response = await rest.request(toPath(path, query), { method: "GET" })
      const responseBody = await readResponseBody(response)

      if (response.status === 204) {
        return true
      }

      if (response.ok || response.status === 404) {
        return false
      }

      throw new CtmApiError(response.status, responseBody, response.headers)
    },
  }
}

/**
 * CTM reads list filters as `direction[]=inbound&direction[]=form`. The shared query helper
 * repeats an array under its own key, so array keys carry the brackets themselves.
 */
function toPath(path: string, query: RestQueryParams | undefined): string {
  return withQuery(path, query, { omitEmptyString: true })
}
