import { ShareSessionStorageError } from "./errors"
import type {
  CreateShareSessionInput,
  GetShareSessionByIdInput,
  RenewShareSessionIfValidInput,
  RevokeShareSessionInput,
  ShareSessionRecord,
} from "./types"

const SHA256_HEX = /^[0-9a-f]{64}$/

export function normalizeShareSessionCreate(input: CreateShareSessionInput): ShareSessionRecord {
  if (!isRecord(input)) throw invalidInput("Share session create input must be an object.")
  const createdAt = inputDate(input.createdAt, "Share session creation time")
  const expiresAt = inputDate(input.expiresAt, "Share session inactivity expiry")
  const absoluteExpiresAt = inputDate(input.absoluteExpiresAt, "Share session absolute expiry")
  if (expiresAt.getTime() <= createdAt.getTime()) {
    throw invalidInput("Share session inactivity expiry must be later than creation time.")
  }
  if (absoluteExpiresAt.getTime() <= createdAt.getTime()) {
    throw invalidInput("Share session absolute expiry must be later than creation time.")
  }
  if (expiresAt.getTime() > absoluteExpiresAt.getTime()) {
    throw invalidInput("Share session inactivity expiry must not exceed its absolute expiry.")
  }

  return {
    id: identifier(input.id, "Share session id"),
    projectId: identifier(input.projectId, "Project id"),
    grantId: identifier(input.grantId, "Share grant id"),
    tokenHash: sha256(input.tokenHash, "Share session token hash"),
    createdAt,
    expiresAt,
    absoluteExpiresAt,
  }
}

export function parseShareSessionRecord(input: unknown): ShareSessionRecord {
  if (!isRecord(input)) throw invalidRecord("Share session row must be an object.")
  try {
    const createdAt = storedDate(input.createdAt, "Share session creation time")
    const expiresAt = storedDate(input.expiresAt, "Share session inactivity expiry")
    const absoluteExpiresAt = storedDate(input.absoluteExpiresAt, "Share session absolute expiry")
    if (expiresAt.getTime() <= createdAt.getTime()) {
      throw invalidRecord("Share session inactivity expiry must be later than creation time.")
    }
    if (absoluteExpiresAt.getTime() <= createdAt.getTime()) {
      throw invalidRecord("Share session absolute expiry must be later than creation time.")
    }
    if (expiresAt.getTime() > absoluteExpiresAt.getTime()) {
      throw invalidRecord("Share session inactivity expiry exceeds its absolute expiry.")
    }

    const revokedAtValue = input.revokedAt
    if (revokedAtValue === null) {
      throw invalidRecord("Share session revocation time must be omitted rather than null.")
    }
    const revokedAt =
      revokedAtValue === undefined
        ? undefined
        : storedDate(revokedAtValue, "Share session revocation time")
    if (revokedAt && revokedAt.getTime() < createdAt.getTime()) {
      throw invalidRecord("Share session revocation time must not precede creation time.")
    }

    return {
      id: identifier(input.id, "Share session id"),
      projectId: identifier(input.projectId, "Project id"),
      grantId: identifier(input.grantId, "Share grant id"),
      tokenHash: sha256(input.tokenHash, "Share session token hash"),
      createdAt,
      expiresAt,
      absoluteExpiresAt,
      ...(revokedAt === undefined ? {} : { revokedAt }),
    }
  } catch (error) {
    if (error instanceof ShareSessionStorageError) {
      if (error.code === "invalid_record") throw error
      throw invalidRecord(error.message.replace(/^\[Sixb\] /, ""), error)
    }
    throw error
  }
}

export function normalizeGetShareSessionByIdInput(
  input: GetShareSessionByIdInput
): GetShareSessionByIdInput {
  if (!isRecord(input)) throw invalidInput("Share session lookup input must be an object.")
  return {
    projectId: identifier(input.projectId, "Project id"),
    id: identifier(input.id, "Share session id"),
  }
}

export function normalizeRenewShareSessionIfValidInput(
  input: RenewShareSessionIfValidInput
): RenewShareSessionIfValidInput {
  if (!isRecord(input)) throw invalidInput("Share session renewal input must be an object.")
  const now = inputDate(input.now, "Share session renewal time")
  const expiresAt = inputDate(input.expiresAt, "Requested Share session expiry")
  if (expiresAt.getTime() <= now.getTime()) {
    throw invalidInput("Requested Share session expiry must be later than renewal time.")
  }
  return {
    projectId: identifier(input.projectId, "Project id"),
    id: identifier(input.id, "Share session id"),
    grantId: identifier(input.grantId, "Share grant id"),
    tokenHash: sha256(input.tokenHash, "Share session token hash"),
    now,
    expiresAt,
  }
}

export function normalizeRevokeShareSessionInput(
  input: RevokeShareSessionInput,
  createdAt?: Date
): RevokeShareSessionInput {
  if (!isRecord(input)) throw invalidInput("Share session revocation input must be an object.")
  const normalized = {
    projectId: identifier(input.projectId, "Project id"),
    id: identifier(input.id, "Share session id"),
    revokedAt: inputDate(input.revokedAt, "Share session revocation time"),
  }
  if (createdAt && normalized.revokedAt.getTime() < createdAt.getTime()) {
    throw invalidInput("Share session revocation time must not precede creation time.")
  }
  return normalized
}

export function cloneShareSessionRecord(input: ShareSessionRecord): ShareSessionRecord {
  return structuredClone(input)
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw invalidInput(`${label} must be a non-empty string without NUL bytes.`)
  }
  return value
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw invalidInput(`${label} must be a lowercase SHA-256 hex digest.`)
  }
  return value
}

function inputDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw invalidInput(`${label} must be a valid Date.`)
  }
  return new Date(value)
}

function storedDate(value: unknown, label: string): Date {
  const parsed =
    value instanceof Date
      ? new Date(value)
      : typeof value === "string"
        ? new Date(value)
        : new Date(Number.NaN)
  if (!Number.isFinite(parsed.getTime())) throw invalidRecord(`${label} is invalid.`)
  return parsed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalidInput(message: string, cause?: unknown): ShareSessionStorageError {
  return new ShareSessionStorageError("invalid_input", `[Sixb] ${message}`, { cause })
}

function invalidRecord(message: string, cause?: unknown): ShareSessionStorageError {
  return new ShareSessionStorageError("invalid_record", `[Sixb] ${message}`, { cause })
}
