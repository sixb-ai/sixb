import { type RestClient, readResponseBody, withQuery } from "@sixb/connector-rest"
import { AceIotApiError } from "./errors"
import type { AceIotRequestMethod, QueryParams } from "./types"

export interface AceIotRequestOptions {
  /**
   * Mark a write that cannot change server state, so the shared transport may replay it.
   * `POST /points/get_timeseries` is the one such route: it is a read that takes a body.
   */
  readonly idempotent?: boolean
}

export interface AceIotHttp {
  get<T>(path: string, query?: QueryParams): Promise<T>
  post<T>(
    path: string,
    body?: unknown,
    query?: QueryParams,
    options?: AceIotRequestOptions
  ): Promise<T>
  put<T>(path: string, body?: unknown, query?: QueryParams): Promise<T>
  patch<T>(path: string, body?: unknown, query?: QueryParams): Promise<T>
  /** A GET whose body is a file. Returns the checked `Response` with its body unread. */
  download(path: string, query?: QueryParams): Promise<Response>
}

export function createAceIotHttp(rest: RestClient): AceIotHttp {
  async function send(
    method: AceIotRequestMethod,
    path: string,
    body: unknown,
    query: QueryParams | undefined,
    idempotent: boolean
  ): Promise<Response> {
    return rest.request(
      withQuery(path, query, { omitEmptyString: true }),
      { method, body },
      { idempotent }
    )
  }

  async function request<T>(
    method: AceIotRequestMethod,
    path: string,
    body?: unknown,
    query?: QueryParams,
    idempotent = method === "GET"
  ): Promise<T> {
    return readJson<T>(await send(method, path, body, query, idempotent))
  }

  return {
    get<T>(path: string, query?: QueryParams) {
      return request<T>("GET", path, undefined, query)
    },
    post<T>(
      path: string,
      body?: unknown,
      query?: QueryParams,
      requestOptions?: AceIotRequestOptions
    ) {
      return request<T>("POST", path, body, query, requestOptions?.idempotent ?? false)
    },
    put<T>(path: string, body?: unknown, query?: QueryParams) {
      return request<T>("PUT", path, body, query, false)
    },
    patch<T>(path: string, body?: unknown, query?: QueryParams) {
      return request<T>("PATCH", path, body, query, false)
    },
    async download(path: string, query?: QueryParams) {
      const response = await send("GET", path, undefined, query, true)
      if (!response.ok) {
        throw new AceIotApiError(
          response.status,
          await readResponseBody(response),
          response.headers
        )
      }

      return response
    },
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const responseBody = await readResponseBody(response)
  if (!response.ok) {
    throw new AceIotApiError(response.status, responseBody, response.headers)
  }

  return responseBody as T
}
