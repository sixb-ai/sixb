import { AuthorizationError } from "@sixb/core"
import { FileUploadSessionError, type FileUploadSessionErrorReason } from "@sixb/core/storage"
import { RequestBodyTooLargeError } from "./request-body"

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

export function handleRouteError(
  error: unknown,
  set: { status?: number | string }
): {
  error: string
} {
  if (error instanceof AuthorizationError) {
    set.status = 403
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

  const message = error instanceof Error ? error.message : String(error)
  set.status = message.includes("not found") || message.includes("Unknown") ? 404 : 400
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
