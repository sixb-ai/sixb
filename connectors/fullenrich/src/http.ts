import {
  type RestClient,
  type RestQueryParams,
  readResponseBody,
  withQuery,
} from "@sixb/connector-rest"
import { FullEnrichApiError } from "./errors"
import { isRecord } from "./validation"

const MAX_ERROR_MESSAGE_CHARACTERS = 500

export interface FullEnrichHttpRequest {
  /** Names the call in error messages, such as `people search`. */
  readonly operation: string
  readonly method: "GET" | "POST"
  readonly path: string
  readonly query?: RestQueryParams
  readonly body?: unknown
  /** Safe to replay. Search and lookup are reads; starting a job is not. */
  readonly idempotent: boolean
  readonly signal?: AbortSignal
  /** Non-2xx statuses whose body is still the documented result. */
  readonly resultStatuses?: readonly number[]
}

export interface FullEnrichHttp {
  request(request: FullEnrichHttpRequest): Promise<Record<string, unknown>>
}

/**
 * Sends one FullEnrich call through the shared REST transport and returns its JSON object body.
 * Every failure becomes a `FullEnrichApiError`, except cancellation, which rethrows its reason.
 */
export function createFullEnrichHttp(
  rest: RestClient,
  connectionSignal: AbortSignal
): FullEnrichHttp {
  return {
    async request(request) {
      const signal = request.signal
        ? AbortSignal.any([connectionSignal, request.signal])
        : connectionSignal
      signal.throwIfAborted()

      let response: Response
      try {
        response = await rest.request(
          withQuery(request.path, request.query),
          {
            method: request.method,
            body: request.body,
            headers: { accept: "application/json" },
            redirect: "error",
            signal,
          },
          { idempotent: request.idempotent, retryable: request.idempotent }
        )
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error
        throw new FullEnrichApiError(
          `[SixbFullEnrich] FullEnrich ${request.operation} could not reach the API.`,
          { cause: error }
        )
      }

      if (!response.ok && !request.resultStatuses?.includes(response.status)) {
        throw apiError(request.operation, response.status, await readOptionalBody(response))
      }

      let body: unknown
      try {
        body = await readResponseBody(response)
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error
        throw new FullEnrichApiError(
          `[SixbFullEnrich] FullEnrich ${request.operation} response could not be read.`,
          { status: response.status, cause: error }
        )
      }
      if (!isRecord(body)) {
        throw new FullEnrichApiError(
          `[SixbFullEnrich] FullEnrich ${request.operation} returned a malformed response.`,
          { status: response.status }
        )
      }
      return body
    },
  }
}

function apiError(operation: string, status: number, body: unknown): FullEnrichApiError {
  const code = isRecord(body) && typeof body.code === "string" ? truncate(body.code) : undefined
  const message =
    isRecord(body) && typeof body.message === "string" ? truncate(body.message) : undefined
  const details = [code ? ` (${code})` : "", message ? `: ${message}` : ""].join("")
  return new FullEnrichApiError(
    `[SixbFullEnrich] FullEnrich ${operation} failed with HTTP ${status}${details}.`,
    { status, ...(code ? { code } : {}) }
  )
}

async function readOptionalBody(response: Response): Promise<unknown> {
  try {
    return await readResponseBody(response)
  } catch {
    return undefined
  }
}

function truncate(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim()
  return collapsed.length <= MAX_ERROR_MESSAGE_CHARACTERS
    ? collapsed
    : `${collapsed.slice(0, MAX_ERROR_MESSAGE_CHARACTERS)}…`
}
