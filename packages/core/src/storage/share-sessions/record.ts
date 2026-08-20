import { ShareSessionStorageError } from "./errors"
import type {
  CreateSharedAccessSessionInput,
  RevokeSharedAccessSessionInput,
  SharedAccessSessionRecord,
} from "./types"

export function normalizeSharedAccessSession(
  input: CreateSharedAccessSessionInput
): SharedAccessSessionRecord {
  assertNonEmpty(input.id, "Session id")
  assertNonEmpty(input.projectId, "Project id")
  assertNonEmpty(input.grantId, "Grant id")
  assertNonEmpty(input.tokenDigest, "Token digest")
  assertValidDate(input.createdAt, "Creation time")
  assertValidDate(input.expiresAt, "Expiry")
  if (input.expiresAt.getTime() <= input.createdAt.getTime()) {
    throw invalid("Shared access session expiry must be later than creation time.")
  }

  return {
    id: input.id,
    projectId: input.projectId,
    grantId: input.grantId,
    tokenDigest: input.tokenDigest,
    createdAt: new Date(input.createdAt),
    expiresAt: new Date(input.expiresAt),
  }
}

export function assertSharedAccessSessionRevocation(
  input: RevokeSharedAccessSessionInput,
  createdAt?: Date
): void {
  assertNonEmpty(input.projectId, "Project id")
  assertNonEmpty(input.sessionId, "Session id")
  assertValidDate(input.revokedAt, "Revocation time")
  if (createdAt && input.revokedAt.getTime() < createdAt.getTime()) {
    throw invalid("Shared access session revocation must not precede creation time.")
  }
}

export function cloneSharedAccessSession(
  input: SharedAccessSessionRecord
): SharedAccessSessionRecord {
  return {
    ...input,
    createdAt: new Date(input.createdAt),
    expiresAt: new Date(input.expiresAt),
    ...(input.revokedAt === undefined ? {} : { revokedAt: new Date(input.revokedAt) }),
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw invalid(`${field} must not be empty.`)
}

function assertValidDate(value: Date, field: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw invalid(`${field} must be a valid date.`)
  }
}

function invalid(message: string): ShareSessionStorageError {
  return new ShareSessionStorageError(`[Sixb] ${message}`, "invalid")
}
