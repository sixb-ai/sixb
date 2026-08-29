import {
  AuthorizationError,
  DelegatedExecutionLimitError,
  OntologyNotFoundError,
  OntologyValidationError,
  type SixbErrorCode,
} from "@sixb/core"
import { isSixbError } from "@sixb/core/internal/errors"
import {
  FileUploadSessionError,
  type FileUploadSessionErrorReason,
  ObjectNotFoundError,
} from "@sixb/core/storage"
import { RequestBodyTooLargeError } from "./request-body"

/** Explicit transport policy for coded failures that are safe to surface as non-500 responses. */
const HTTP_STATUS_BY_ERROR_CODE: Partial<Record<SixbErrorCode, number>> = {
  "connector.adapter_invalid": 502,
  "connector.authorization_invalid": 400,
  "connector.authorization_required": 409,
  "connector.configuration_invalid": 400,
  "connector.credentials_unavailable": 503,
  "connector.not_found": 404,
  "connector.operation_conflict": 409,
  "connector.operation_in_progress": 409,
  "connector.provider_failed": 502,
  "connector.provider_unavailable": 503,
  "connector.replacement_required": 409,
  "connector.revocation_pending": 409,
  "dataset.not_found": 404,
  "dataset.version_not_found": 404,
}

export function toIsoString(value: Date): string {
  return value.toISOString()
}

export function parseDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${value}`)
  }

  return parsed
}

export function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer: ${value}`)
  }

  return parsed
}

/**
 * A storage role the runtime was not configured with.
 *
 * 501 and not 400: the request was well-formed and the caller can do nothing
 * about it. It is not 404 either — that would claim the resource is absent when
 * what is absent is the store that would have recorded it. Callers that treat
 * "no rows" and "not recorded" the same way silently report an empty history as
 * a healthy one.
 */
export function unconfiguredStorageResponse(
  set: { status?: number | string },
  role: string
): { error: string } {
  set.status = 501
  return { error: `[SixbServer] ${role} is not configured on this runtime.` }
}

export function handleRouteError(
  error: unknown,
  set: { status?: number | string }
): {
  error: string
  code?: SixbErrorCode
} {
  if (isSixbError(error)) {
    set.status = HTTP_STATUS_BY_ERROR_CODE[error.code] ?? 500
    return { error: error.message, code: error.code }
  }

  if (error instanceof AuthorizationError) {
    set.status = 403
    return { error: error.message }
  }

  if (error instanceof DelegatedExecutionLimitError) {
    set.status = 400
    return { error: error.message }
  }

  if (error instanceof FileUploadSessionError) {
    set.status = fileUploadSessionErrorStatus(error.reason)
    return { error: error.message }
  }

  if (error instanceof RequestBodyTooLargeError) {
    set.status = 413
    return { error: error.message }
  }

  // Before the OntologyValidationError branch: it is a subclass, and it is the half that is a
  // missing resource rather than bad input.
  if (error instanceof OntologyNotFoundError || error instanceof ObjectNotFoundError) {
    set.status = 404
    return { error: error.message }
  }

  if (error instanceof OntologyValidationError) {
    set.status = 400
    return { error: error.message }
  }

  // Legacy uncoded errors remain bad requests until their primitive receives a vertical migration.
  // Crucially, wording no longer changes transport semantics.
  const message = error instanceof Error ? error.message : String(error)
  set.status = 400
  return { error: message }
}

function fileUploadSessionErrorStatus(reason: FileUploadSessionErrorReason): number {
  switch (reason) {
    case "not_found":
      return 404
    case "expired":
      return 410
    case "already_completed":
    case "already_aborted":
      return 409
  }
}
