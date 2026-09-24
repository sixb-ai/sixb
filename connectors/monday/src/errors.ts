import { parseRetryAfter } from "@sixb/connector-rest"
import { record } from "./validation"

export interface MondayGraphQLError {
  readonly message: string
  readonly path?: readonly (string | number)[]
  readonly extensions?: Readonly<Record<string, unknown>>
}
/** Includes partial data: a mutation error does not imply that nothing was written. */
export class MondayApiError extends Error {
  readonly errors: readonly MondayGraphQLError[]
  readonly partialData: unknown
  readonly requestId: string | undefined
  readonly retryAfterMs: number | null
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly headers: Headers
  ) {
    const errors =
      record(body) && Array.isArray(body.errors)
        ? body.errors.filter(
            (e): e is MondayGraphQLError => record(e) && typeof e.message === "string"
          )
        : []
    super(
      `[SixbMonday] API request failed (HTTP ${status})${errors.length ? `: ${errors.map((e) => e.message).join("; ")}` : "."}`
    )
    this.name = "MondayApiError"
    this.errors = errors
    this.partialData = record(body) ? body.data : undefined
    const extensions = record(body) && record(body.extensions) ? body.extensions : undefined
    this.requestId = typeof extensions?.request_id === "string" ? extensions.request_id : undefined
    this.retryAfterMs = retryDelay(body, headers)
  }
}
export function retryDelay(body: unknown, headers: Headers): number | null {
  const delays: number[] = []
  const header = parseRetryAfter(headers.get("retry-after"))
  if (header !== null && Number.isFinite(header)) delays.push(header)
  const add = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) delays.push(value * 1000)
  }
  if (record(body)) {
    add(body.retry_in_seconds)
    if (Array.isArray(body.errors))
      for (const error of body.errors) {
        if (!record(error)) continue
        add(error.retry_in_seconds)
        if (record(error.extensions)) {
          add(error.extensions.retry_in_seconds)
          if (record(error.extensions.error_data)) add(error.extensions.error_data.retry_in_seconds)
        }
      }
  }
  return delays.length ? Math.max(...delays) : null
}
