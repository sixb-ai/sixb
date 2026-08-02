import { SixbError, type SixbErrorCode, type SixbErrorOptions } from "@sixb/core/errors"
export interface ImapConnectorErrorOptions extends SixbErrorOptions {
  /** Subclasses narrow the failure; direct callers leave this alone. */
  readonly code?: SixbErrorCode
}

export class ImapConnectorError extends SixbError {
  override readonly name: string = "ImapConnectorError"

  constructor(message: string, options: ImapConnectorErrorOptions = {}) {
    super(options.code ?? "connector.unavailable", `[SixbImap] ${message}`, options)
  }
}

export class ImapAbortedError extends ImapConnectorError {
  override readonly name = "ImapAbortedError"

  constructor() {
    super("Operation aborted.", { code: "runtime.cancelled" })
  }
}

export class ImapDownloadTooLargeError extends ImapConnectorError {
  override readonly name = "ImapDownloadTooLargeError"

  constructor(
    readonly uid: number,
    readonly part: string,
    readonly maxBytes: number,
    readonly expectedSize?: number
  ) {
    const expected = expectedSize === undefined ? "" : ` (expected ${expectedSize} bytes)`
    super(`Message ${uid} part ${part} exceeds the ${maxBytes}-byte limit${expected}.`, {
      code: "connector.request_failed",
    })
  }
}

export class ImapPartUnavailableError extends ImapConnectorError {
  override readonly name = "ImapPartUnavailableError"

  constructor(
    readonly uid: number,
    readonly part: string
  ) {
    super(`Message ${uid} part ${part} is unavailable: the server returned no content.`, {
      code: "connector.request_failed",
    })
  }
}

export function imapOperationError(
  operation: string,
  error: unknown,
  secrets: readonly string[] = []
): ImapConnectorError {
  if (error instanceof ImapConnectorError) {
    return error
  }

  const detail = sanitizedErrorMessage(error, secrets)
  const suffix = detail ? `: ${detail}` : "."
  return new ImapConnectorError(`${operation} failed${suffix}`, { cause: error })
}

function sanitizedErrorMessage(error: unknown, secrets: readonly string[]): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  let sanitized = raw.replaceAll(/\s+/g, " ").trim()

  for (const secret of secrets) {
    if (secret) {
      sanitized = sanitized.replaceAll(secret, "[redacted]")
    }
  }

  return sanitized.slice(0, 300)
}
