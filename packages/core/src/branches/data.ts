import { createHash } from "node:crypto"
import type { SixbHostView } from "../runtime/host"
import type { BranchNotice, BranchRecord } from "../storage/branches"
import type { Storage } from "../storage/types"

/**
 * Production's side of a hosted branch's data: its database on production's instance and the role
 * it runs as. Nothing here runs branch code: the branch's runtime loads its copy into the database
 * itself, as the role, checked against its own definitions.
 */

/**
 * A provider that hosts branches on production's own instance: each in a database its own role
 * owns, which production reaches only as that role. See `@sixb/pg`'s `hosted-branches.ts`.
 */
export interface BranchHostingStorage {
  /**
   * What production lacks to host branches, such as `CREATEDB`, or a lock table large enough for
   * a copy of `objectTypes` types, or null.
   */
  unmetHostedBranchRequirement(objectTypes?: number): Promise<string | null>
  /**
   * Creates the role, which cannot log in yet, and the empty database it owns. Production never
   * acts in it but to create its own extensions there: the branch's runtime migrates it and loads
   * its copy, as the role. Refuses a namespace that exists. Says whether it capped the role's
   * temporary files, which takes production's `SET` on them.
   */
  createHostedBranch(
    name: string,
    limits: BranchRoleLimits
  ): Promise<{ readonly tempFileLimit: boolean }>
  /**
   * A login for one start of the branch's runtime, and where it logs in: a new password, valid
   * while `enforceHostedBranchLimits` keeps renewing it. Ends the sessions of an earlier start.
   */
  openHostedBranch(name: string): Promise<{ readonly url: string; readonly schemaName: string }>
  /** Takes the role's login away and ends its sessions. Closing a missing one does nothing. */
  closeHostedBranch(name: string): Promise<void>
  /** Drops the database, with everything in it, and the role. Dropping a missing one does nothing. */
  dropHostedBranch(name: string): Promise<void>
  /**
   * Stops the role's statements and sessions past its limits, whatever it SET, and closes the
   * branch when it takes what production cannot spare.
   */
  enforceHostedBranchLimits(name: string, limits: BranchRoleLimits): Promise<BranchEnforcement>
  /** Where a branch reaches production's instance: what its sandbox's network lets through. */
  hostedBranchDatabaseAddress(): { readonly host: string; readonly port: number }
}

/** What one round of `enforceBranchLimits` did. */
export interface BranchEnforcement {
  /** The statements it cancelled and the sessions it ended. */
  readonly stopped: number
  /**
   * Set when it closed the branch, and why: its runtime can log in no more. Its worker stops it
   * with `branchClosureNotice`; opening it again gives it a new login.
   */
  readonly closed: BranchClosure | null
}

/** Why production closed a branch. */
export type BranchClosure =
  /** It held more advisory locks, or more of the lock table, than the framework ever takes. */
  | { readonly reason: "locks"; readonly locks: number }
  /** Branches together held more of the lock table than they may, and it held the most. */
  | { readonly reason: "crowded"; readonly locks: number }
  /** A session held a lock that another role's session waited for. */
  | { readonly reason: "blocking" }
  /** A session was connected to another database than the branch's own. */
  | { readonly reason: "elsewhere"; readonly database: string }
  /** The branch's database grew past its size limit. */
  | { readonly reason: "disk"; readonly bytes: number; readonly limitBytes: number }

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
  /**
   * What the branch's database may hold on production's disk, in MB, its copy included. Defaults
   * to twice production's own database, at least 20 GiB. Checked once a minute, every round past
   * 80% of it; past it, production closes the branch.
   */
  readonly databaseSizeLimitMb?: number
  /** The object types the copy loads, which sizes its locks. Defaults to the host's ontology's. */
  readonly objectTypes?: number
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
 * Makes the branch's home anew: an empty database and the role that owns it, so what the branch
 * wrote goes with the last copy. Production never acts in it; the branch's runtime migrates it and
 * loads its copy there, as the role.
 */
export async function prepareBranchData(
  host: SixbHostView,
  branch: Pick<BranchRecord, "namespace">,
  limits: BranchRoleLimits = {}
): Promise<{ readonly tempFileLimit: boolean }> {
  const hosting = requireHosting(host.storage)
  await hosting.dropHostedBranch(branch.namespace)
  return hosting.createHostedBranch(branch.namespace, withObjectTypes(host, limits))
}

/** Drops the branch's database, with its copy and what it wrote, and its role. */
export async function dropBranchData(host: SixbHostView, branch: BranchRecord): Promise<void> {
  await requireHosting(host.storage).dropHostedBranch(branch.namespace)
}

/**
 * Takes the branch's login away and ends its sessions, once its runtime stops: a password its code
 * kept opens nothing until the next `hostBranchDatabase`.
 */
export async function closeBranchData(
  host: SixbHostView,
  branch: Pick<BranchRecord, "namespace">
): Promise<void> {
  await requireHosting(host.storage).closeHostedBranch(branch.namespace)
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

/** What production's storage lacks to host branches, or null: asked before a worker starts. */
export async function branchHostingRequirement(host: SixbHostView): Promise<string | null> {
  if (!isBranchHostingStorage(host.storage)) return HOSTING_STORAGE

  return host.storage.unmetHostedBranchRequirement(objectTypesOf(host))
}

/** Holds the branch's role to its limits, which it cannot SET away: see `BranchHostingStorage`. */
export async function enforceBranchLimits(
  host: SixbHostView,
  branch: BranchRecord,
  limits: BranchRoleLimits = {}
): Promise<BranchEnforcement> {
  return requireHosting(host.storage).enforceHostedBranchLimits(
    branch.namespace,
    withObjectTypes(host, limits)
  )
}

function withObjectTypes(host: SixbHostView, limits: BranchRoleLimits): BranchRoleLimits {
  return { objectTypes: objectTypesOf(host), ...limits }
}

function objectTypesOf(host: SixbHostView): number {
  return host.definitions.ontology.listObjectTypes().length
}

/**
 * What a branch's row says once production closed it. Past its disk limit, a restart would close it
 * again, so only a new copy starts it over; any other closure leaves its data fit to start again.
 */
export function branchClosureNotice(closure: BranchClosure): BranchNotice {
  const code = closure.reason === "disk" ? "database-limit" : "database-closed"

  return { code, message: closureMessage(closure) }
}

function closureMessage(closure: BranchClosure): string {
  const stopped = "This branch stopped:"
  const again = "Start it again to keep going."

  switch (closure.reason) {
    case "disk":
      return `${stopped} its data grew past ${gigabytes(closure.limitBytes)} on production's database, its limit. Refresh it from production to start again from a new copy.`
    case "locks":
      return `${stopped} it held ${closure.locks} database locks at once, more than production's database can spare for one branch. ${again}`
    case "crowded":
      return `${stopped} branches together held more database locks than production's database can spare, and this one held the most (${closure.locks}). ${again}`
    case "blocking":
      return `${stopped} another session on production's database waited on a lock it held. ${again}`
    case "elsewhere":
      return `${stopped} its code connected to another database of production's instance ('${closure.database}'), which a branch may not do. ${again}`
  }
}

function gigabytes(bytes: number): string {
  return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`
}

export function isBranchHostingStorage(
  storage: Storage
): storage is Storage & BranchHostingStorage {
  return "createHostedBranch" in storage && typeof storage.createHostedBranch === "function"
}

const HOSTING_STORAGE =
  "@sixb/pg for production's storage: hosted branches each run on a database of production's PostgreSQL instance, with a role limited to it"

function requireHosting(storage: Storage): BranchHostingStorage {
  if (isBranchHostingStorage(storage)) return storage

  throw new Error(`[Sixb] Hosted branches need ${HOSTING_STORAGE}.`)
}
