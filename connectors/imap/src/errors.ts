import {
  isSixbError,
  SixbError,
  type SixbErrorCode,
  type SixbErrorOptions,
} from "@sixb/core/errors"

export interface ImapConnectorErrorOptions extends SixbErrorOptions {
  /** Narrows the failure past the module default; most callers leave this alone. */
  readonly code?: SixbErrorCode
}

/** An IMAP failure, prefixed and defaulted to `connector.unavailable`. */
export function imapConnectorError(
  message: string,
  options: ImapConnectorErrorOptions = {}
): SixbError {
  return new SixbError(options.code ?? "connector.unavailable", `[SixbImap] ${message}`, options)
}

/**
 * Attributes a transport failure to the operation that raised it, with the account password
 * scrubbed from whatever the server said. An IMAP failure passes through untouched: restating it
 * would only bury the code and message the connector already chose.
 */
export function imapOperationError(
  operation: string,
  error: unknown,
  secrets: readonly string[] = []
): SixbError {
  if (isSixbError(error)) {
    return error
  }

  const detail = sanitizedErrorMessage(error, secrets)
  const suffix = detail ? `: ${detail}` : "."
  return imapConnectorError(`${operation} failed${suffix}`, { cause: error })
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
