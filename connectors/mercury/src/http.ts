import { type RestClient, readResponseBody, withQuery } from "@sixb/connector-rest"
import { MercuryApiError } from "./errors"
import type { MercuryRequestMethod, QueryParams } from "./types"

export interface MercuryHttp {
  get<T>(path: string, query?: QueryParams): Promise<T>
  post<T>(path: string, body?: unknown, query?: QueryParams): Promise<T>
  patch<T>(path: string, body?: unknown, query?: QueryParams): Promise<T>
  delete<T>(path: string, query?: QueryParams): Promise<T>
}

export function createMercuryHttp(rest: RestClient): MercuryHttp {
  async function request<T>(
    method: MercuryRequestMethod,
    path: string,
    body?: unknown,
    query?: QueryParams
  ): Promise<T> {
    const response = await rest.request(withQuery(path, query, { omitEmptyString: true }), {
      method,
      body,
    })
    const responseBody = await readResponseBody(response)
    if (!response.ok) {
      throw new MercuryApiError(response.status, responseBody, response.headers)
    }

    return responseBody as T
  }

  return {
    get<T>(path: string, query?: QueryParams) {
      return request<T>("GET", path, undefined, query)
    },
    post<T>(path: string, body?: unknown, query?: QueryParams) {
      return request<T>("POST", path, body, query)
    },
    patch<T>(path: string, body?: unknown, query?: QueryParams) {
      return request<T>("PATCH", path, body, query)
    },
    delete<T>(path: string, query?: QueryParams) {
      return request<T>("DELETE", path, undefined, query)
    },
  }
}
