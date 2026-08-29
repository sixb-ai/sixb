import { createHash } from "node:crypto"
import type { Principal } from "../../auth"
import { snapshotRuntimeAccessPlan } from "../../authorization/access-plan"
import type { AuthorizablePrincipal } from "../../execution/types"
import { stableJsonStringify } from "../../json"
import type { ObjectRef } from "../../ontology"
import { ShareGrantStorageError } from "./errors"
import type {
  CreateShareGrantInput,
  GetShareGrantByIdInput,
  ListShareGrantsInput,
  NormalizedListShareGrantsInput,
  RevokeShareGrantInput,
  ShareAuthoritySnapshot,
  ShareGrantRecord,
} from "./types"

const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200
const MAX_DESTINATION_PATH_LENGTH = 4_096
const SHA256_HEX = /^[0-9a-f]{64}$/
const SHARED_APP_PATH_PREFIX = "/shared"

/** Normalize, detach, and derive every persisted field owned by Share grant storage. */
export function normalizeShareGrantCreate(input: CreateShareGrantInput): ShareGrantRecord {
  if (!isRecord(input)) throw invalidInput("Share grant create input must be an object.")
  const projectId = identifier(input.projectId, "Project id")
  const id = identifier(input.id, "Share grant id")
  const definitionId = identifier(input.definitionId, "Share definition id")
  const target = normalizeObjectRef(input.target, "Share target")
  const issuedBy = normalizeAuthorizablePrincipal(input.issuedBy, "Share issuer")
  const authoritySnapshot = normalizeAuthoritySnapshot(input.authoritySnapshot, target)
  const tokenHash = sha256(input.tokenHash, "Share token hash")
  const destinationPath = normalizeDestinationPath(input.destinationPath)
  const createdAt = inputDate(input.createdAt, "Share creation time")
  const expiresAt = inputDate(input.expiresAt, "Share expiry time")

  if (expiresAt.getTime() <= createdAt.getTime()) {
    throw invalidInput("Share expiry time must be later than creation time.")
  }

  return {
    id,
    projectId,
    definitionId,
    target,
    issuedBy,
    authoritySnapshot,
    authorityDigest: shareAuthorityDigest(authoritySnapshot),
    tokenHash,
    destinationPath,
    createdAt,
    expiresAt,
  }
}

/** Parse a provider row and reject unknown/corrupt durable authority instead of widening it. */
export function parseShareGrantRecord(input: unknown): ShareGrantRecord {
  if (!isRecord(input)) throw invalidRecord("Share grant row must be an object.")

  try {
    const projectId = identifier(input.projectId, "Project id")
    const id = identifier(input.id, "Share grant id")
    const definitionId = identifier(input.definitionId, "Share definition id")
    const target = normalizeObjectRef(input.target, "Share target")
    const issuedBy = normalizeAuthorizablePrincipal(input.issuedBy, "Share issuer")
    const authoritySnapshot = normalizeAuthoritySnapshot(input.authoritySnapshot, target)
    const authorityDigest = sha256(input.authorityDigest, "Share authority digest")
    const expectedDigest = shareAuthorityDigest(authoritySnapshot)
    if (authorityDigest !== expectedDigest) {
      throw invalidRecord("Share authority digest does not match its snapshot.")
    }
    const tokenHash = sha256(input.tokenHash, "Share token hash")
    const destinationPath = normalizeDestinationPath(input.destinationPath)
    const createdAt = storedDate(input.createdAt, "Share creation time")
    const expiresAt = storedDate(input.expiresAt, "Share expiry time")
    if (expiresAt.getTime() <= createdAt.getTime()) {
      throw invalidRecord("Share expiry time must be later than creation time.")
    }

    const revokedAtValue = input.revokedAt
    const revokedByValue = input.revokedBy
    if ((revokedAtValue === undefined) !== (revokedByValue === undefined)) {
      throw invalidRecord("Share revocation time and actor must be stored together.")
    }
    if (revokedAtValue === null || revokedByValue === null) {
      throw invalidRecord("Share revocation fields must be omitted rather than null.")
    }

    const revokedAt =
      revokedAtValue === undefined ? undefined : storedDate(revokedAtValue, "Share revocation time")
    const revokedBy =
      revokedByValue === undefined
        ? undefined
        : normalizePrincipal(revokedByValue, "Share revocation actor")
    if (revokedAt && revokedAt.getTime() < createdAt.getTime()) {
      throw invalidRecord("Share revocation time must not precede creation time.")
    }

    return {
      id,
      projectId,
      definitionId,
      target,
      issuedBy,
      authoritySnapshot,
      authorityDigest,
      tokenHash,
      destinationPath,
      createdAt,
      expiresAt,
      ...(revokedAt === undefined ? {} : { revokedAt }),
      ...(revokedBy === undefined ? {} : { revokedBy }),
    }
  } catch (error) {
    if (error instanceof ShareGrantStorageError) {
      if (error.code === "invalid_record") throw error
      throw invalidRecord(error.message.replace(/^\[Sixb\] /, ""), error)
    }
    throw error
  }
}

export function normalizeGetShareGrantByIdInput(
  input: GetShareGrantByIdInput
): GetShareGrantByIdInput {
  if (!isRecord(input)) throw invalidInput("Share grant lookup input must be an object.")
  return {
    projectId: identifier(input.projectId, "Project id"),
    id: identifier(input.id, "Share grant id"),
  }
}

export function normalizeListShareGrantsInput(
  input: ListShareGrantsInput
): NormalizedListShareGrantsInput {
  if (!isRecord(input)) throw invalidInput("Share grant list input must be an object.")
  const projectId = identifier(input.projectId, "Project id")
  const definitionId =
    input.definitionId === undefined
      ? undefined
      : identifier(input.definitionId, "Share definition id")
  const target =
    input.target === undefined ? undefined : normalizeObjectRef(input.target, "Share target")
  const includeRevoked = optionalBoolean(input.includeRevoked, "includeRevoked")
  const includeExpired = optionalBoolean(input.includeExpired, "includeExpired")
  const now = inputDate(input.now, "Share grant list time")
  const limit = safeInteger(input.limit ?? DEFAULT_LIST_LIMIT, "Share grant list limit", 1)
  const offset = safeInteger(input.offset ?? 0, "Share grant list offset", 0)
  if (limit > MAX_LIST_LIMIT) {
    throw invalidInput(`Share grant list limit must not exceed ${MAX_LIST_LIMIT}.`)
  }

  return {
    projectId,
    ...(definitionId === undefined ? {} : { definitionId }),
    ...(target === undefined ? {} : { target }),
    includeRevoked,
    includeExpired,
    now,
    limit,
    offset,
  }
}

export function normalizeRevokeShareGrantInput(
  input: RevokeShareGrantInput,
  createdAt?: Date
): RevokeShareGrantInput {
  if (!isRecord(input)) throw invalidInput("Share grant revocation input must be an object.")
  const normalized = {
    projectId: identifier(input.projectId, "Project id"),
    id: identifier(input.id, "Share grant id"),
    revokedAt: inputDate(input.revokedAt, "Share revocation time"),
    revokedBy: normalizePrincipal(input.revokedBy, "Share revocation actor"),
  }
  if (createdAt && normalized.revokedAt.getTime() < createdAt.getTime()) {
    throw invalidInput("Share revocation time must not precede creation time.")
  }
  return normalized
}

export function cloneShareGrantRecord(input: ShareGrantRecord): ShareGrantRecord {
  return structuredClone(input)
}

export function shareAuthorityDigest(snapshot: ShareAuthoritySnapshot): string {
  return createHash("sha256").update(stableJsonStringify(snapshot)).digest("hex")
}

function normalizeAuthoritySnapshot(value: unknown, target: ObjectRef): ShareAuthoritySnapshot {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.access)) {
    throw invalidInput("Share authority snapshot version is unsupported.")
  }
  let access: ShareAuthoritySnapshot["access"]
  try {
    access = snapshotRuntimeAccessPlan(value.access as never)
  } catch (error) {
    if (error instanceof ShareGrantStorageError) throw error
    const reason = error instanceof Error ? error.message.replace(/^\[Sixb\] /, "") : String(error)
    throw invalidInput(`Share authority snapshot is invalid: ${reason}`, error)
  }
  assertAccessTargets(access, target)
  return Object.freeze({ version: 1, access })
}

function assertAccessTargets(access: ShareAuthoritySnapshot["access"], target: ObjectRef): void {
  for (const grant of access.grants) {
    if (grant.kind === "object.view") {
      for (const root of grant.selection.roots) {
        if (!sameObjectRef(root.anchor, target)) {
          throw invalidInput("Every Share view root must match the exact Share target.")
        }
      }
      continue
    }
    for (const subject of grant.subjects) {
      if (!sameObjectRef(subject, target)) {
        throw invalidInput("Every shared Action subject must match the exact Share target.")
      }
    }
  }
}

function sameObjectRef(left: ObjectRef, right: ObjectRef): boolean {
  return left.objectTypeId === right.objectTypeId && left.primaryId === right.primaryId
}

function normalizeObjectRef(value: unknown, label: string): ObjectRef {
  if (!isRecord(value)) throw invalidInput(`${label} must be an exact object reference.`)
  return Object.freeze({
    objectTypeId: identifier(value.objectTypeId, `${label} object type id`),
    primaryId: identifier(value.primaryId, `${label} primary id`),
  })
}

function normalizeAuthorizablePrincipal(value: unknown, label: string): AuthorizablePrincipal {
  const principal = normalizePrincipal(value, label)
  if (principal.type === "system") {
    throw invalidInput(`${label} must be a user or service account.`)
  }
  return principal
}

function normalizePrincipal(value: unknown, label: string): Principal {
  if (!isRecord(value)) throw invalidInput(`${label} must be a principal.`)
  if (value.type !== "user" && value.type !== "serviceAccount" && value.type !== "system") {
    throw invalidInput(`${label} has an unsupported type.`)
  }
  return Object.freeze({ type: value.type, id: identifier(value.id, `${label} id`) })
}

function normalizeDestinationPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidInput("Share destination path must not be empty.")
  }
  if (value.length > MAX_DESTINATION_PATH_LENGTH) {
    throw invalidInput(
      `Share destination path must not exceed ${MAX_DESTINATION_PATH_LENGTH} characters.`
    )
  }
  if (
    !value.startsWith("/") ||
    value.includes("//") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw invalidInput(
      "Share destination path must be an absolute same-origin pathname without query or fragment."
    )
  }
  const normalized = new URL(value, "https://sixb.invalid").pathname
  if (normalized !== value) {
    throw invalidInput("Share destination path must already be canonical.")
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(value).replaceAll("\\", "/")
  } catch {
    throw invalidInput("Share destination path must contain valid percent-encoding.")
  }
  if (decoded === SHARED_APP_PATH_PREFIX || decoded.startsWith(`${SHARED_APP_PATH_PREFIX}/`)) {
    throw invalidInput(
      "Share destination path must not use the framework-owned '/shared' namespace."
    )
  }
  return value
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

function optionalBoolean(value: unknown, label: string): boolean {
  if (value === undefined) return false
  if (typeof value !== "boolean") throw invalidInput(`${label} must be a boolean.`)
  return value
}

function safeInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw invalidInput(`${label} must be a safe integer greater than or equal to ${minimum}.`)
  }
  return value as number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalidInput(message: string, cause?: unknown): ShareGrantStorageError {
  return new ShareGrantStorageError("invalid_input", `[Sixb] ${message}`, { cause })
}

function invalidRecord(message: string, cause?: unknown): ShareGrantStorageError {
  return new ShareGrantStorageError("invalid_record", `[Sixb] ${message}`, { cause })
}
