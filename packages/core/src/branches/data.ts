import { createHash } from "node:crypto"
import type { SixbHostView } from "../runtime/host"
import type { BranchRecord } from "../storage/branches"
import type { Storage } from "../storage/types"

/**
 * Production's side of a hosted branch's data: its namespace on production's instance and the role
 * it runs as. Nothing here runs branch code: the branch's runtime loads its copy into the schema
 * itself, as the role, checked against its own definitions.
 */

/**
 * A provider that hosts branches on production's own instance: each in a schema its own role
 * owns, which production reaches only as that role. See `@sixb/pg`'s `hosted-branches.ts`.
 */
export interface BranchHostingStorage {
  /**
   * Creates the role and the empty schema it owns. Production never acts in it: the branch's
   * runtime migrates it and loads its copy, as the role. Refuses a namespace that exists. Says
   * whether it capped the role's temporary files, which takes production's `SET` on them.
   */
  createHostedBranch(
    name: string,
    limits: BranchRoleLimits
  ): Promise<{ readonly tempFileLimit: boolean }>
  /** A new password for the role, for one start of the branch's runtime, and where it logs in. */
  openHostedBranch(name: string): Promise<{ readonly url: string; readonly schemaName: string }>
  /** Drops the schema, with everything in it, and the role. Dropping a missing one does nothing. */
  dropHostedBranch(name: string): Promise<void>
  /** Stops the role's statements and transactions past its limits, whatever it SET. */
  enforceHostedBranchLimits(name: string, limits: BranchRoleLimits): Promise<number>
  /** Where a branch reaches production's instance: what its sandbox's network lets through. */
  hostedBranchDatabaseAddress(): { readonly host: string; readonly port: number }
}

/** Bounds on what a branch's role takes from production's instance. */
export interface BranchRoleLimits {
  /** Connections the role may hold at once. Defaults to 5. */
  readonly connectionLimit?: number
  /** Longest statement, in ms, before production cancels it. Defaults to 15 minutes. */
  readonly statementTimeoutMillis?: number
  /** Longest transaction, in ms, before production ends its session. Defaults to 30 minutes. */
  readonly transactionTimeoutMillis?: number
  /** Longest wait inside an open transaction, in ms, before production ends it. Defaults to 60 s. */
  readonly idleInTransactionMillis?: number
  /**
   * Temporary files one session may write, in kB. 1 GiB. Only a production that may set
   * `temp_file_limit` caps them: `createHostedBranch` says whether it did.
   */
  readonly tempFileLimitKb?: number
}

const MAX_NAMESPACE_LENGTH = 40

/**
 * The namespace a branch's copy lives in: what a provider takes in every engine, readable, and
 * kept apart from every other branch's by a hash of the exact name.
 */
export function branchNamespaceName(branch: string): string {
  const hash = createHash("sha256").update(branch).digest("hex").slice(0, 8)
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAMESPACE_LENGTH - hash.length - 1)
    .replace(/-+$/, "")

  return slug ? `${slug}-${hash}` : hash
}

/**
 * Makes the branch's home anew: an empty schema and the role that owns it, so what the branch wrote
 * goes with the last copy. Production never acts in it; the branch's runtime migrates it and loads
 * its copy there, as the role.
 */
export async function prepareBranchData(
  host: SixbHostView,
  branch: Pick<BranchRecord, "namespace">,
  limits: BranchRoleLimits = {}
): Promise<{ readonly tempFileLimit: boolean }> {
  const hosting = requireHosting(host.storage)
  await hosting.dropHostedBranch(branch.namespace)
  return hosting.createHostedBranch(branch.namespace, limits)
}

/** Drops the branch's schema, with its copy and what it wrote, and its role. */
export async function dropBranchData(host: SixbHostView, branch: BranchRecord): Promise<void> {
  await requireHosting(host.storage).dropHostedBranch(branch.namespace)
}

/** A new login for the branch's role, for one start of its runtime. */
export async function hostBranchDatabase(
  host: SixbHostView,
  branch: BranchRecord
): Promise<{ readonly url: string; readonly schemaName: string }> {
  return requireHosting(host.storage).openHostedBranch(branch.namespace)
}

/** Where the branch reaches production's instance. */
export function branchDatabaseAddress(host: SixbHostView): {
  readonly host: string
  readonly port: number
} {
  return requireHosting(host.storage).hostedBranchDatabaseAddress()
}

/** Holds the branch's role to its limits, which it cannot SET away: see `BranchHostingStorage`. */
export async function enforceBranchLimits(
  host: SixbHostView,
  branch: BranchRecord,
  limits: BranchRoleLimits = {}
): Promise<number> {
  return requireHosting(host.storage).enforceHostedBranchLimits(branch.namespace, limits)
}

export function isBranchHostingStorage(
  storage: Storage
): storage is Storage & BranchHostingStorage {
  return "createHostedBranch" in storage && typeof storage.createHostedBranch === "function"
}

function requireHosting(storage: Storage): BranchHostingStorage {
  if (isBranchHostingStorage(storage)) return storage

  throw new Error(
    "[Sixb] Hosted branches run on a schema of production's PostgreSQL instance, with a role limited to it. Use @sixb/pg for production's storage."
  )
}
