import { createHash, randomBytes, randomUUID } from "node:crypto"
import { assertAuthorized, isRuntimeAllowed } from "../authorization"
import type { AuthorizablePrincipal, ExecutionContext } from "../execution"
import { resolveExecutionScopeAuthorization } from "../execution/authorization"
import type { ObjectRef } from "../ontology"
import type { DefinitionCatalog } from "../runtime/definitions"
import type { SixbRuntimeContext } from "../runtime/types"
import { ObjectNotFoundError, type ShareGrantRecord, ShareGrantStorageError } from "../storage"
import { compileShareAccessPlan } from "./compiler"
import type { ShareDefinition } from "./types"

const MAX_CREATE_ATTEMPTS = 5

export type ShareErrorReason =
  | "invalid_input"
  | "not_found"
  | "unauthenticated"
  | "storage_unavailable"
  | "storage_failure"

export class ShareError extends Error {
  readonly name = "ShareError"

  constructor(
    readonly reason: ShareErrorReason,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}

type ShareTargetObjectTypeId<TDefinition extends ShareDefinition> =
  TDefinition["target"]["objectTypeId"]

/** Public lifecycle view. Durable secrets and authority internals never cross this boundary. */
export type SharedAccessGrant = Omit<
  ShareGrantRecord,
  "projectId" | "authoritySnapshot" | "authorityDigest" | "tokenHash"
>

export interface SharedAccessInvitation {
  readonly grant: SharedAccessGrant
  /** Returned once. Storage retains only its SHA-256 digest. */
  readonly secret: string
}

export interface IssueSharedAccessInput<TDefinition extends ShareDefinition = ShareDefinition> {
  readonly target: ObjectRef<NoInfer<ShareTargetObjectTypeId<TDefinition>>>
  readonly destinationPath: string
  readonly expiresAt: Date
}

export interface IssueSharedAccessByIdInput extends IssueSharedAccessInput {
  readonly definitionId: string
}

export interface ListSharedAccessInput<TDefinition extends ShareDefinition = ShareDefinition> {
  readonly target?: ObjectRef<NoInfer<ShareTargetObjectTypeId<TDefinition>>>
  readonly includeRevoked?: boolean
  readonly includeExpired?: boolean
  readonly limit?: number
  readonly offset?: number
}

export interface ListSharedAccessByIdInput extends Omit<ListSharedAccessInput, "target"> {
  readonly definitionId: string
  /** Filter within the definition's target Object Type. */
  readonly primaryId?: string
}

export interface SharedAccessGrantListResult {
  readonly grants: readonly SharedAccessGrant[]
  readonly total: number
  readonly hasMore: boolean
}

export interface SharesRuntime {
  listDefinitions(): readonly ShareDefinition[]
  getDefinitionById(definitionId: string): ShareDefinition | null
  issue<const TDefinition extends ShareDefinition>(
    definition: TDefinition,
    input: IssueSharedAccessInput<TDefinition>
  ): Promise<SharedAccessInvitation>
  issueById(input: IssueSharedAccessByIdInput): Promise<SharedAccessInvitation>
  list<const TDefinition extends ShareDefinition>(
    definition: TDefinition,
    input?: ListSharedAccessInput<TDefinition>
  ): Promise<SharedAccessGrantListResult>
  listById(input: ListSharedAccessByIdInput): Promise<SharedAccessGrantListResult>
  revoke(grantId: string): Promise<SharedAccessGrant | null>
}

export function createSharesRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  definitions: DefinitionCatalog<ShareDefinition>
): SharesRuntime {
  const managementPrincipal = (): AuthorizablePrincipal => {
    const authority = resolveExecutionScopeAuthorization(runtime.projectId, {
      execution,
      authorization: runtime.runtimeAuthorization,
    })
    if (authority.type !== "principal" || authority.context.principal.type === "system") {
      throw new ShareError(
        "unauthenticated",
        "[Sixb] Shared access grants require user or service-account authority."
      )
    }
    return {
      type: authority.context.principal.type,
      id: authority.context.principal.id,
    }
  }

  const canManage = (shareId: string): boolean => {
    try {
      managementPrincipal()
      return isRuntimeAllowed(runtime, { kind: "share.manage", shareId })
    } catch {
      return false
    }
  }

  const resolveManageableDefinition = (definitionId: unknown): ShareDefinition => {
    const id = validDefinitionId(definitionId)
    managementPrincipal()
    // Authorize the opaque id before resolving it so callers without `can.share` cannot use the
    // 403/404 distinction as a Share-definition existence oracle.
    assertCanManage(runtime, id)
    return resolveDefinition(definitions, id)
  }

  const issueByDefinition = async (
    definition: ShareDefinition,
    input: IssueSharedAccessInput
  ): Promise<SharedAccessInvitation> => {
    assertInputObject(input, "Shared access issue input")
    const issuer = managementPrincipal()
    assertCanManage(runtime, definition.id)
    const storage = requireShareStorage(runtime)
    const createdAt = new Date()
    const expiresAt = validFutureDate(input.expiresAt, createdAt)
    const target = exactTarget(definition, input.target)

    // This canonical read checks both the caller's current object authority and target existence.
    const object = await runtime.objectReader.getByPrimaryId({
      objectTypeId: target.objectTypeId,
      primaryId: target.primaryId,
    })
    if (!object) {
      throw new ObjectNotFoundError(target.objectTypeId, target.primaryId, "Share target not found")
    }

    const authoritySnapshot = {
      version: 1 as const,
      access: compileShareAccessPlan({
        share: definition,
        target,
        ontology: runtime.ontology,
        actions: runtime.actionRegistry,
      }),
    }

    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      const secret = randomBytes(32).toString("base64url")
      try {
        const grant = await storage.create({
          id: `shr_${randomUUID()}`,
          projectId: runtime.projectId,
          definitionId: definition.id,
          target,
          issuedBy: issuer,
          authoritySnapshot,
          tokenHash: sha256(secret),
          destinationPath: input.destinationPath,
          createdAt,
          expiresAt,
        })
        return { grant: publicGrant(grant), secret }
      } catch (error) {
        if (error instanceof ShareGrantStorageError && error.code === "invalid_input") {
          throw new ShareError("invalid_input", error.message, { cause: error })
        }
        if (
          !(error instanceof ShareGrantStorageError) ||
          error.code !== "duplicate" ||
          attempt === MAX_CREATE_ATTEMPTS - 1
        ) {
          throw storageFailure("issue", error)
        }
      }
    }

    throw storageFailure("issue")
  }

  const listByDefinition = async (
    definition: ShareDefinition,
    input: ListSharedAccessInput = {}
  ): Promise<SharedAccessGrantListResult> => {
    assertInputObject(input, "Shared access list input")
    managementPrincipal()
    assertCanManage(runtime, definition.id)
    const storage = requireShareStorage(runtime)
    const target = input.target === undefined ? undefined : exactTarget(definition, input.target)
    try {
      const result = await storage.list({
        projectId: runtime.projectId,
        definitionId: definition.id,
        ...(target === undefined ? {} : { target }),
        includeRevoked: input.includeRevoked,
        includeExpired: input.includeExpired,
        now: new Date(),
        limit: input.limit,
        offset: input.offset,
      })
      return { ...result, grants: result.grants.map(publicGrant) }
    } catch (error) {
      if (error instanceof ShareGrantStorageError && error.code === "invalid_input") {
        throw new ShareError("invalid_input", error.message, { cause: error })
      }
      throw storageFailure("list", error)
    }
  }

  return {
    listDefinitions: () => definitions.list().filter((definition) => canManage(definition.id)),
    getDefinitionById: (definitionId) => {
      const definition = definitions.getById(definitionId)
      return definition && canManage(definition.id) ? definition : null
    },
    async issue(definition, input) {
      return issueByDefinition(
        resolveManageableDefinition(definitionIdFromReference(definition)),
        input
      )
    },
    async issueById(input) {
      assertInputObject(input, "Shared access issue input")
      return issueByDefinition(resolveManageableDefinition(input.definitionId), input)
    },
    async list(definition, input) {
      return listByDefinition(
        resolveManageableDefinition(definitionIdFromReference(definition)),
        input
      )
    },
    async listById(input) {
      assertInputObject(input, "Shared access list input")
      const definition = resolveManageableDefinition(input.definitionId)
      const { primaryId, includeRevoked, includeExpired, limit, offset } = input
      return listByDefinition(definition, {
        ...(primaryId === undefined
          ? {}
          : {
              target: {
                objectTypeId: definition.target.objectTypeId,
                primaryId,
              },
            }),
        includeRevoked,
        includeExpired,
        limit,
        offset,
      })
    },
    revoke: async (grantId) => {
      const actor = managementPrincipal()
      const storage = requireShareStorage(runtime)
      if (typeof grantId !== "string" || !grantId.trim()) {
        throw new ShareError("invalid_input", "[Sixb] Shared access grant id must not be empty.")
      }
      let current: ShareGrantRecord | null
      try {
        current = await storage.getById({ projectId: runtime.projectId, id: grantId })
      } catch (error) {
        throw storageFailure("load for revocation", error)
      }
      if (!current) return null
      // Do not turn grant ids into an existence oracle. Missing definitions and grants outside the
      // caller's management authority are indistinguishable from missing grants.
      if (!definitions.getById(current.definitionId) || !canManage(current.definitionId)) {
        return null
      }
      try {
        const revoked = await storage.revoke({
          projectId: runtime.projectId,
          id: grantId,
          revokedAt: new Date(),
          revokedBy: actor,
        })
        return revoked ? publicGrant(revoked) : null
      } catch (error) {
        throw storageFailure("revoke", error)
      }
    },
  }
}

function definitionIdFromReference(value: unknown): unknown {
  return typeof value === "object" && value !== null
    ? (value as { readonly id?: unknown }).id
    : undefined
}

function assertInputObject(value: unknown, label: string): asserts value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ShareError("invalid_input", `[Sixb] ${label} must be an object.`)
  }
}

function resolveDefinition(
  definitions: DefinitionCatalog<ShareDefinition>,
  definitionId: unknown
): ShareDefinition {
  const id = validDefinitionId(definitionId)
  const definition = definitions.getById(id)
  if (!definition) {
    throw new ShareError("not_found", `[Sixb] Unknown Share definition '${id}'.`)
  }
  return definition
}

function validDefinitionId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ShareError("invalid_input", "[Sixb] Share definition id must not be empty.")
  }
  return value
}

function assertCanManage(runtime: SixbRuntimeContext, shareId: string): void {
  assertAuthorized(runtime, { kind: "share.manage", shareId })
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

function exactTarget(definition: ShareDefinition, value: unknown): ObjectRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ShareError("invalid_input", "[Sixb] Share target must be an exact object reference.")
  }
  const objectTypeId = (value as { readonly objectTypeId?: unknown }).objectTypeId
  const primaryId = (value as { readonly primaryId?: unknown }).primaryId
  if (typeof objectTypeId !== "string" || typeof primaryId !== "string" || !primaryId.trim()) {
    throw new ShareError("invalid_input", "[Sixb] Share target must be an exact object reference.")
  }
  if (objectTypeId !== definition.target.objectTypeId) {
    throw new ShareError(
      "invalid_input",
      `[Sixb] Share '${definition.id}' targets '${definition.target.objectTypeId}', not '${objectTypeId}'.`
    )
  }
  return Object.freeze({ objectTypeId, primaryId })
}

function validFutureDate(value: unknown, now: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()) || value <= now) {
    throw new ShareError(
      "invalid_input",
      "[Sixb] Shared access expiry must be a valid future date."
    )
  }
  return new Date(value)
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function publicGrant(record: ShareGrantRecord): SharedAccessGrant {
  const {
    projectId: _projectId,
    authoritySnapshot: _authoritySnapshot,
    authorityDigest: _authorityDigest,
    tokenHash: _tokenHash,
    ...grant
  } = record
  return structuredClone(grant)
}

function storageFailure(operation: string, cause?: unknown): ShareError {
  return new ShareError("storage_failure", `[Sixb] Share grant storage failed to ${operation}.`, {
    cause,
  })
}
