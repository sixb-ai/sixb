import { createHash, randomBytes, randomUUID } from "node:crypto"
import { assertAuthorized, isAllowed } from "../authorization"
import { resolveRuntimeAuthorization } from "../execution/authorization"
import type { AuthorizablePrincipal, ExecutionContext } from "../execution/types"
import type { ObjectRef } from "../ontology"
import type { DefinitionCatalog } from "../runtime/definitions"
import type { SixbRuntimeContext } from "../runtime/types"
import { ObjectNotFoundError } from "../storage"
import type { SharedAccessGrantRecord } from "../storage/share-grants"
import { ShareError } from "./errors"
import type { ShareTypeDefinition } from "./types"
import { snapshotShareTypeGrants } from "./validation"

export type ShareTypeReference = ShareTypeDefinition | string

export type SharedAccessGrant = Omit<
  SharedAccessGrantRecord,
  "projectId" | "tokenDigest" | "issuedEvidenceId" | "revokedEvidenceId"
>

export interface SharedAccessInvitation {
  readonly grant: SharedAccessGrant
  /** Returned once. Only its digest is persisted. */
  readonly secret: string
}

export interface IssueSharedAccessInput {
  readonly type: ShareTypeReference
  readonly target: ObjectRef
  readonly expiresAt: Date
}

export interface ListSharedAccessInput {
  readonly type: ShareTypeReference
  readonly target: ObjectRef
  readonly includeRevoked?: boolean
  readonly includeExpired?: boolean
}

export interface SharesRuntime {
  listTypes(): readonly ShareTypeDefinition[]
  getTypeById(shareTypeId: string): ShareTypeDefinition | null
  issue(input: IssueSharedAccessInput): Promise<SharedAccessInvitation>
  list(input: ListSharedAccessInput): Promise<readonly SharedAccessGrant[]>
  revoke(grantId: string): Promise<SharedAccessGrant | null>
}

interface ShareObjectReader {
  get(objectTypeId: string, primaryId: string): Promise<unknown | null>
}

export function createSharesRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  definitions: DefinitionCatalog<ShareTypeDefinition>,
  objects: ShareObjectReader
): SharesRuntime {
  const canManage = (shareTypeId: string) =>
    resolveManagementPrincipal(runtime, execution) !== null &&
    isAllowed(runtime.authorization, { kind: "share.manage", shareTypeId })

  return {
    listTypes: () => definitions.list().filter((type) => canManage(type.id)),
    getTypeById: (shareTypeId) => {
      const type = definitions.getById(shareTypeId)
      return type && canManage(type.id) ? type : null
    },
    async issue(input) {
      const issuer = assertManagementPrincipal(runtime, execution)
      const storage = requireShareStorage(runtime)
      const type = resolveType(definitions, input.type)
      assertCanManage(runtime, type)

      const createdAt = new Date()
      if (
        !(input.expiresAt instanceof Date) ||
        !Number.isFinite(input.expiresAt.getTime()) ||
        input.expiresAt.getTime() <= createdAt.getTime()
      ) {
        throw new ShareError(
          "invalid_input",
          "[Sixb] Shared access expiry must be a valid future date."
        )
      }
      await assertExactTargetAccess(objects, type, input.target)

      const secret = randomBytes(32).toString("base64url")
      const grant = await storage.create({
        id: `shr_${randomUUID()}`,
        projectId: runtime.projectId,
        shareTypeId: type.id,
        target: { ...input.target },
        issuedBy: issuer,
        grants: snapshotShareTypeGrants(type),
        tokenDigest: createHash("sha256").update(secret).digest("base64url"),
        createdAt,
        expiresAt: new Date(input.expiresAt),
        issuedEvidenceId: `she_${randomUUID()}`,
      })

      return { grant: toPublicGrant(grant), secret }
    },
    async list(input) {
      assertManagementPrincipal(runtime, execution)
      const storage = requireShareStorage(runtime)
      const type = resolveType(definitions, input.type)
      assertCanManage(runtime, type)
      await assertExactTargetAccess(objects, type, input.target)

      const grants = await storage.list({
        projectId: runtime.projectId,
        shareTypeId: type.id,
        target: input.target,
        includeRevoked: input.includeRevoked,
        includeExpired: input.includeExpired,
      })
      return grants.map(toPublicGrant)
    },
    async revoke(grantId) {
      if (typeof grantId !== "string" || !grantId.trim()) {
        throw new ShareError("invalid_input", "[Sixb] Shared access grant id must not be empty.")
      }
      const actor = assertManagementPrincipal(runtime, execution)
      const storage = requireShareStorage(runtime)
      const current = await storage.get({ projectId: runtime.projectId, grantId })
      if (!current) return null

      const type = resolveType(definitions, current.shareTypeId)
      assertCanManage(runtime, type)
      await assertExactTargetAccess(objects, type, current.target)
      const revoked = await storage.revoke({
        projectId: runtime.projectId,
        grantId,
        revokedAt: new Date(),
        revokedBy: actor,
        evidenceId: `she_${randomUUID()}`,
      })
      return revoked ? toPublicGrant(revoked) : null
    },
  }
}

function resolveType(
  definitions: DefinitionCatalog<ShareTypeDefinition>,
  reference: ShareTypeReference
): ShareTypeDefinition {
  const id =
    typeof reference === "string"
      ? reference
      : typeof reference === "object" && reference !== null && typeof reference.id === "string"
        ? reference.id
        : null
  if (!id?.trim()) {
    throw new ShareError("invalid_input", "[Sixb] Share type id must not be empty.")
  }
  const type = definitions.getById(id)
  if (!type) {
    throw new ShareError("not_found", `[Sixb] Unknown share type '${id}'.`)
  }
  return type
}

function assertManagementPrincipal(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext
): AuthorizablePrincipal {
  const principal = resolveManagementPrincipal(runtime, execution)
  if (!principal) {
    throw new ShareError(
      "unauthenticated",
      "[Sixb] Shared access grants require matching user or service-account authority."
    )
  }
  return principal
}

function assertCanManage(runtime: SixbRuntimeContext, type: ShareTypeDefinition): void {
  assertAuthorized(runtime, { kind: "share.manage", shareTypeId: type.id })
}

function resolveManagementPrincipal(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext
): AuthorizablePrincipal | null {
  const authorization = resolveRuntimeAuthorization(runtime.runtimeAuthorization)
  if (authorization.type !== "principal" || execution.requestedBy === undefined) {
    return null
  }
  if (
    execution.requestedBy.type !== authorization.context.principal.type ||
    execution.requestedBy.id !== authorization.context.principal.id
  ) {
    return null
  }
  return { ...execution.requestedBy }
}

async function assertExactTargetAccess(
  objects: ShareObjectReader,
  type: ShareTypeDefinition,
  target: ObjectRef
): Promise<void> {
  if (
    typeof target !== "object" ||
    target === null ||
    typeof target.objectTypeId !== "string" ||
    !target.objectTypeId.trim() ||
    typeof target.primaryId !== "string" ||
    !target.primaryId.trim()
  ) {
    throw new ShareError("invalid_input", "[Sixb] Share target must be an exact object reference.")
  }
  if (target.objectTypeId !== type.target.id) {
    throw new ShareError(
      "invalid_input",
      `[Sixb] Share type '${type.id}' targets '${type.target.id}', not '${target.objectTypeId}'.`
    )
  }
  const object = await objects.get(target.objectTypeId, target.primaryId)
  if (!object) {
    throw new ObjectNotFoundError(target.objectTypeId, target.primaryId, "Share target not found")
  }
}

function requireShareStorage(runtime: SixbRuntimeContext) {
  const storage = runtime.storage.shareGrants
  if (!storage) {
    throw new ShareError(
      "storage_unavailable",
      "[Sixb] Share grant storage is not configured on this runtime."
    )
  }
  return storage
}

function toPublicGrant(record: SharedAccessGrantRecord): SharedAccessGrant {
  const {
    projectId: _projectId,
    tokenDigest: _tokenDigest,
    issuedEvidenceId: _issued,
    revokedEvidenceId: _revoked,
    ...grant
  } = record
  return grant
}
