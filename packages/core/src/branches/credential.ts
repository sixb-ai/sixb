import { createHash, randomBytes } from "node:crypto"
import { isAllowed } from "../authorization/decision"
import { resolveAuthorizationContext } from "../authorization/resolve"
import type { AuthorizationContext } from "../authorization/types"
import { LAKE_SLICE_KEEP_MS } from "../datasets/lake-slices"
import type { SecurityDefinitionCatalog } from "../security/registry"
import type { LakeSliceRecord, Storage } from "../storage"

/**
 * A branch's credential in production. A laptop's branch holds this, never its developer's own
 * session: it reads production as that person only where the branch needs it, the files of its
 * objects and its lake slice, and lives as long as the slice. Any other route refuses it.
 */
export const BRANCH_CREDENTIAL_PREFIX = "sixb_branch_"

export function newBranchCredential(): { readonly credential: string; readonly hash: string } {
  const credential = `${BRANCH_CREDENTIAL_PREFIX}${randomBytes(32).toString("base64url")}`
  return { credential, hash: branchCredentialHash(credential) }
}

export function branchCredentialHash(credential: string): string {
  return createHash("sha256").update(credential).digest("hex")
}

/** The routes a branch credential reaches: its objects' files, its lake token, its slice. */
const BRANCH_CREDENTIAL_ROUTES: readonly (readonly [string, RegExp])[] = [
  ["GET", /^\/api\/objects\/[^/]+\/[^/]+\/files\/content$/],
  ["HEAD", /^\/api\/objects\/[^/]+\/[^/]+\/files\/content$/],
  ["POST", /^\/api\/branches\/lake-token$/],
  ["DELETE", /^\/api\/branches\/slices\/[^/]+$/],
]

export function isBranchCredentialRoute(method: string, pathname: string): boolean {
  return BRANCH_CREDENTIAL_ROUTES.some(
    ([allowed, pattern]) => allowed === method.toUpperCase() && pattern.test(pathname)
  )
}

export interface BranchCredentialHost {
  readonly id: string
  readonly storage: Pick<Storage, "lakeSlices" | "auth">
  readonly definitions: { readonly security: Pick<SecurityDefinitionCatalog, "listResolvedRoles"> }
}

/**
 * The person a branch credential reads production as, and its slice, or null: a credential of no
 * live slice, of a person no longer active, or of one who may no longer copy to a branch, reads
 * nothing.
 */
export async function authorizeBranchCredential(
  host: BranchCredentialHost,
  credential: string,
  now = new Date()
): Promise<{ readonly slice: LakeSliceRecord; readonly person: AuthorizationContext } | null> {
  const slices = host.storage.lakeSlices
  const auth = host.storage.auth
  if (!slices || !auth || !credential.startsWith(BRANCH_CREDENTIAL_PREFIX)) return null

  const slice = await slices.findByCredentialHash({
    projectId: host.id,
    credentialHash: branchCredentialHash(credential),
  })
  if (!slice) return null
  const liveUntil = (slice.lastTokenExpiresAt ?? slice.createdAt).getTime() + LAKE_SLICE_KEEP_MS
  if (liveUntil <= now.getTime()) return null

  const user = await auth.users.getById({ projectId: host.id, id: slice.userId })
  if (!user || user.status !== "active") return null

  const memberships = await auth.groupMemberships.listForUser({
    projectId: host.id,
    userId: slice.userId,
  })
  const person = resolveAuthorizationContext({
    principal: { type: "user", id: slice.userId },
    groupIds: memberships.map((membership) => membership.groupId),
    roles: host.definitions.security.listResolvedRoles(),
  })
  return isAllowed(person, { kind: "source.manage" }) ? { slice, person } : null
}
