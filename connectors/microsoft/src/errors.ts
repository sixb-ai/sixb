import { isRecord } from "./guards"

export class MicrosoftConfigurationError extends Error {
  constructor(message: string) {
    super(`[SixbMicrosoft] ${message}`)
    this.name = "MicrosoftConfigurationError"
  }
}

export class MicrosoftAuthError extends Error {
  readonly code?: string

  constructor(code?: string) {
    // SDK error descriptions can contain credentials. Only expose a bounded error code.
    super(
      `[SixbMicrosoft] Authentication failed${code ? ` (${code})` : ""}. Check the application credentials and tenant configuration.`
    )
    this.name = "MicrosoftAuthError"
    this.code = code
  }
}

export class MicrosoftProtocolError extends Error {
  constructor(message: string) {
    super(`[SixbMicrosoft] ${message}`)
    this.name = "MicrosoftProtocolError"
  }
}

export interface GraphErrorDetail {
  readonly code?: string
  readonly message?: string
  readonly innerError?: Readonly<Record<string, unknown>>
  readonly details?: readonly GraphErrorDetail[]
}

export class MicrosoftApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly requestId?: string
  readonly retryAfter?: string
  /** Preserved Graph envelope for programmatic inspection. May contain sensitive data. */
  readonly body: unknown
  /** For delta 410 responses. Explicitly resync; never silently discard local state. */
  readonly location?: string

  constructor(response: Response, body: unknown) {
    const detail = isRecord(body) && isRecord(body.error) ? body.error : undefined
    const code = typeof detail?.code === "string" ? detail.code : undefined
    super(`[SixbMicrosoft] Graph request failed (${response.status}${code ? `, ${code}` : ""}).`)
    this.name = "MicrosoftApiError"
    this.status = response.status
    this.code = code
    this.body = body
    this.requestId = response.headers.get("request-id") ?? undefined
    this.retryAfter = response.headers.get("retry-after") ?? undefined
    this.location = response.headers.get("location") ?? undefined
  }
}

/**
 * Whether a mail, calendar or contacts call failed because the user has no Exchange Online
 * mailbox: an unlicensed admin or service account, a guest, or a mailbox that is inactive,
 * soft-deleted or hosted on-premises. A user that does not exist fails differently
 * (`ErrorInvalidUser`), as does every other error.
 */
export function isMailboxNotEnabled(error: unknown): boolean {
  return (
    error instanceof MicrosoftApiError &&
    error.status === 404 &&
    error.code === "MailboxNotEnabledForRESTAPI"
  )
}
