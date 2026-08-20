import { type RestClient, readResponseBody, withQuery } from "@sixb/connector-rest"
import { PennylaneApiError } from "./errors"
import type { PennylaneRequestMethod, QueryParams } from "./types"

export interface PennylaneHttp {
  get<T>(path: string, query?: QueryParams): Promise<T>
  post<T>(path: string, body?: unknown, query?: QueryParams): Promise<T>
  put<T>(path: string, body?: unknown, query?: QueryParams): Promise<T>
}

export function createPennylaneHttp(rest: RestClient): PennylaneHttp {
  async function request<T>(
    method: PennylaneRequestMethod,
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
      throw new PennylaneApiError(response.status, responseBody, response.headers)
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
    put<T>(path: string, body?: unknown, query?: QueryParams) {
      return request<T>("PUT", path, body, query)
    },
  }
}
