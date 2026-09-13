import { parseRetryAfter } from "@sixb/connector-rest"

export class NotionApiError extends Error {
  readonly name = "NotionApiError"
  readonly code: string | null
  readonly requestId: string | null
  readonly retryAfterMs: number | null
  readonly headers: Headers

  constructor(
    readonly status: number,
    readonly responseBody: unknown,
    headers: HeadersInit = {}
  ) {
    const body = isRecord(responseBody) ? responseBody : {}
    const message = typeof body.message === "string" ? `: ${body.message}` : ""
    super(`[SixbNotion] Notion API request failed with ${status}${message}`)
    this.headers = new Headers(headers)
    this.code = typeof body.code === "string" ? body.code : null
    this.requestId =
      typeof body.request_id === "string" ? body.request_id : this.headers.get("x-request-id")
    this.retryAfterMs = parseRetryAfter(this.headers.get("retry-after"))
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
