import { type RestClient, readResponseBody, withQuery } from "@sixb/connector-rest"
import { UnipileApiError } from "./errors"
import type { QueryParams, UnipileRequestMethod } from "./types"

export interface UnipileHttp {
  get<T>(path: string, query?: QueryParams, retryable?: boolean): Promise<T>
  post<T>(path: string, body?: unknown, query?: QueryParams): Promise<T>
  delete<T>(path: string, query?: QueryParams): Promise<T>
}

export function createUnipileHttp(rest: RestClient): UnipileHttp {
  async function request<T>(
    method: UnipileRequestMethod,
    path: string,
    body?: unknown,
    query?: QueryParams,
    retryable = false
  ): Promise<T> {
    const response = await rest.request(
      withQuery(path, query, { arrayFormat: "comma" }),
      { method, body },
      { retryable }
    )
    const responseBody = await readResponseBody(response)
    if (!response.ok) {
      throw new UnipileApiError(response.status, responseBody, response.headers)
    }

    return responseBody as T
  }

  return {
    get<T>(path: string, query?: QueryParams, retryable = false) {
      return request<T>("GET", path, undefined, query, retryable)
    },
    post<T>(path: string, body?: unknown, query?: QueryParams) {
      return request<T>("POST", path, body, query, false)
    },
    delete<T>(path: string, query?: QueryParams) {
      return request<T>("DELETE", path, undefined, query, false)
    },
  }
}
