import { SixbError, type SixbErrorCode, type SixbErrorOptions } from "../../errors"

/**
 * Transport-agnostic reasons a file upload session operation can fail. Mapping a
 * reason to an HTTP status (or any other transport) is the responsibility of the
 * boundary that surfaces it, not of core.
 */
const FILE_UPLOAD_SESSION_ERROR_REASONS = [
  "not_found",
  "expired",
  "already_completed",
  "already_aborted",
] as const

export type FileUploadSessionErrorReason = (typeof FILE_UPLOAD_SESSION_ERROR_REASONS)[number]

/**
 * One code per reason, because a boundary that can only read one of them cannot tell an unknown
 * session from a finished one — and those are a 404 and a 409. The reason stays on the error for
 * callers inside the runtime; the code is what survives the trip out.
 */
const CODE_BY_REASON: Record<FileUploadSessionErrorReason, SixbErrorCode> = {
  not_found: "storage.upload_not_found",
  expired: "storage.upload_expired",
  already_completed: "storage.upload_conflict",
  already_aborted: "storage.upload_conflict",
}

/**
 * Error for file upload session invariants and invalid state transitions.
 */
export function fileUploadSessionError(
  reason: FileUploadSessionErrorReason,
  message: string,
  options: SixbErrorOptions = {}
): SixbError {
  return new SixbError(CODE_BY_REASON[reason], message, {
    ...options,
    details: { reason, ...options.details },
  })
}
