import type { AuthorizablePrincipal } from "../../execution"
import { ShareGrantStorageError } from "./errors"
import type {
  CreateSharedAccessGrantInput,
  RevokeSharedAccessGrantInput,
  SharedAccessGrantRecord,
  SharedAccessGrantRef,
} from "./types"

export function normalizeSharedAccessGrant(
  input: CreateSharedAccessGrantInput
): SharedAccessGrantRecord {
  assertNonEmpty(input.id, "Grant id")
  assertNonEmpty(input.projectId, "Project id")
  assertNonEmpty(input.shareTypeId, "Share type id")
  assertNonEmpty(input.target.objectTypeId, "Target object type id")
  assertNonEmpty(input.target.primaryId, "Target primary id")
  assertPrincipal(input.issuedBy, "Issuer")
  assertNonEmpty(input.tokenDigest, "Token digest")
  assertNonEmpty(input.issuedEvidenceId, "Issued evidence id")
  if (!Number.isFinite(input.createdAt.getTime()) || !Number.isFinite(input.expiresAt.getTime())) {
    throw invalid("Creation and expiry must be valid dates.")
  }
  if (input.expiresAt.getTime() <= input.createdAt.getTime()) {
    throw invalid("Expiry must be later than creation time.")
  }
  if (input.grants.length === 0) {
    throw invalid("Grant snapshot must not be empty.")
  }
  const grants = normalizeSharedAccessGrantRefs(input.grants)

  return {
    id: input.id,
    projectId: input.projectId,
    shareTypeId: input.shareTypeId,
    target: {
      objectTypeId: input.target.objectTypeId,
      primaryId: input.target.primaryId,
    },
    issuedBy: clonePrincipal(input.issuedBy),
    grants,
    tokenDigest: input.tokenDigest,
    createdAt: new Date(input.createdAt),
    expiresAt: new Date(input.expiresAt),
    issuedEvidenceId: input.issuedEvidenceId,
  }
}

export function assertSharedAccessGrantRevocation(
  input: RevokeSharedAccessGrantInput,
  createdAt?: Date
): void {
  assertNonEmpty(input.projectId, "Project id")
  assertNonEmpty(input.grantId, "Grant id")
  assertPrincipal(input.revokedBy, "Revocation actor")
  assertNonEmpty(input.evidenceId, "Revoked evidence id")
  if (!Number.isFinite(input.revokedAt.getTime())) throw invalid("Revocation time must be valid.")
  if (createdAt && input.revokedAt.getTime() < createdAt.getTime()) {
    throw invalid("Revocation time must not precede creation time.")
  }
}

export function normalizeSharedAccessGrantRefs(value: unknown): readonly SharedAccessGrantRef[] {
  if (!Array.isArray(value)) throw invalid("Grant snapshot must be an array.")
  if (value.length === 0) throw invalid("Grant snapshot must not be empty.")
  return value.map((grant) => {
    if (typeof grant !== "object" || grant === null || Array.isArray(grant)) {
      throw invalid("Grant snapshot entries must be objects.")
    }
    const candidate = grant as { capability?: unknown; objectTypeId?: unknown; actionId?: unknown }
    if (candidate.capability === "view" && typeof candidate.objectTypeId === "string") {
      assertNonEmpty(candidate.objectTypeId, "View grant object type id")
      return { capability: "view", objectTypeId: candidate.objectTypeId }
    }
    if (candidate.capability === "apply" && typeof candidate.actionId === "string") {
      assertNonEmpty(candidate.actionId, "Apply grant action id")
      return { capability: "apply", actionId: candidate.actionId }
    }
    throw invalid("Unknown shared access grant capability or target.")
  })
}

export function cloneSharedAccessGrant(input: SharedAccessGrantRecord): SharedAccessGrantRecord {
  return {
    ...input,
    target: { ...input.target },
    issuedBy: { ...input.issuedBy },
    grants: input.grants.map((grant) => ({ ...grant })),
    createdAt: new Date(input.createdAt),
    expiresAt: new Date(input.expiresAt),
    ...(input.revokedAt === undefined ? {} : { revokedAt: new Date(input.revokedAt) }),
    ...(input.revokedBy === undefined ? {} : { revokedBy: { ...input.revokedBy } }),
  }
}

export function clonePrincipal(principal: AuthorizablePrincipal): AuthorizablePrincipal {
  return { type: principal.type, id: principal.id }
}

function assertPrincipal(principal: AuthorizablePrincipal, field: string): void {
  if (principal.type !== "user" && principal.type !== "serviceAccount") {
    throw invalid(`${field} must be a user or service account.`)
  }
  assertNonEmpty(principal.id, `${field} id`)
}

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw invalid(`${field} must not be empty.`)
}

function invalid(message: string): ShareGrantStorageError {
  return new ShareGrantStorageError(`[Sixb] ${message}`, "invalid")
}
