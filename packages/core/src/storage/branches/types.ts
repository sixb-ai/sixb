/**
 * A git branch of the project that runs next to production: production copies what its creator
 * reads into a namespace of its own (a schema on production's instance, with a role limited to
 * it), and a branch worker runs the branch's code against that copy in a sandbox. Whoever wants it
 * running says so in `wanted`; the worker holding the lease works toward it and writes what it
 * finds. `packages/core/src/branches/README.md` describes the lifecycle.
 */
export interface BranchRecord {
  readonly projectId: string
  /** The git branch. */
  readonly name: string
  /** The storage namespace that holds its copy: lowercase, digits and dashes. */
  readonly namespace: string
  readonly wanted: BranchWanted
  readonly state: BranchState
  /** Who opened it: the copy holds what this person reads in production. */
  readonly createdBy: string
  /** What the branch's runtime asks every request for. Only production holds it. */
  readonly key: string
  /**
   * The port the runtime listens on in its sandbox, drawn when the sandbox is made and kept with
   * it: null while it has none.
   */
  readonly port: number | null
  /** The sandbox provider's name for its saved state, once it was created. */
  readonly sandbox: string | null
  /** Where production reaches the runtime, while it runs. */
  readonly url: string | null
  /** The runtime's generation: each change that reaches its checkout starts a new one. */
  readonly generation: number | null
  /** The checkout's commit the runtime serves. */
  readonly commit: string | null
  readonly error: BranchError | null
  /** The copy of production it runs on, or null before the first copy and once it is deleted. */
  readonly data: BranchData | null
  /** A new copy was asked for: the next one is taken after this. */
  readonly refreshRequestedAt: Date | null
  /**
   * The git branch's head on the remote, as the worker last read it; null until it has. A branch
   * runs once the remote has it, and ends once the remote no longer does.
   */
  readonly remoteCommit: string | null
  /** What its creator should know about the copy or the runtime, such as a reset copy. */
  readonly notices: readonly BranchNotice[]
  /** The worker holding the branch, until `leaseExpiresAt`. */
  readonly owner: string | null
  readonly leaseExpiresAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
  /** When someone last opened it. Its data goes after 14 days unopened. */
  readonly openedAt: Date
  /** When someone last reached its runtime. A branch nobody reaches stops. */
  readonly lastSeenAt: Date
  /** Grows by one with every write: `update` compares it to tell a stale write from a fresh one. */
  readonly revision: number
}

/** `deleted` drops its sandbox, its schema and its role, then its row. */
export type BranchWanted = "running" | "stopped" | "deleted"

/** Where a branch's runtime is: stopped, copying production, starting, serving, or failed. */
export type BranchState = "stopped" | "copying" | "starting" | "ready" | "failed"

/** Why a branch isn't serving, with the project file the error points at when there is one. */
export interface BranchError {
  readonly message: string
  readonly file?: string
}

/**
 * `data-reset`: its machine was lost, so it took a new copy and what it wrote is gone.
 * `no-dev-env`: it runs without the project's `dev` values, which the worker could not read.
 * `machine-ended`: its sandbox reached its provider's time limit, and the branch stopped.
 * `temp-files-uncapped`: production may not cap its role's temporary files (`temp_file_limit`),
 * so one heavy query of the branch's can fill production's disk.
 * `database-limit`: its data grew past its disk limit, so production stopped it; only a new copy
 * starts it again.
 * `database-closed`: it held up production's database (locks) or reached another of its databases,
 * so production stopped it; it keeps its data, and starting it again gives it a new login.
 */
export interface BranchNotice {
  readonly code:
    | "data-reset"
    | "no-dev-env"
    | "machine-ended"
    | "temp-files-uncapped"
    | "database-limit"
    | "database-closed"
  readonly message: string
}

/** The copy a branch runs on, taken at S. */
export interface BranchData {
  /** S: when production took the copy. */
  readonly takenAt: Date
  /** The objects it holds. */
  readonly objects: number
  /** Object types left out of it, and why. */
  readonly skipped: readonly { readonly objectTypeId: string; readonly reason: string }[]
  /** The lake slice it reads production's datasets through, when production's lake has forks. */
  readonly lakeSliceId: string | null
}

/** What a write may change: everything but the identity and the bookkeeping. */
export type BranchChanges = Partial<
  Omit<
    BranchRecord,
    "projectId" | "name" | "namespace" | "createdBy" | "createdAt" | "updatedAt" | "revision"
  >
>

export interface BranchRef {
  readonly projectId: string
  readonly name: string
}

export interface BranchStorage {
  get(input: BranchRef): Promise<BranchRecord | null>
  /** Every branch of the project, by name. */
  list(input: { readonly projectId: string }): Promise<readonly BranchRecord[]>
  /** Adds the branch at revision 1. A name already taken returns that branch, unchanged. */
  create(
    record: Omit<BranchRecord, "updatedAt" | "revision">
  ): Promise<{ readonly branch: BranchRecord; readonly created: boolean }>
  /**
   * Writes `changes` when the branch is still at `revision`, and returns it as written; null when
   * it moved on or is gone. Without `revision` it writes over whatever is there.
   */
  update(
    input: BranchRef & { readonly revision?: number; readonly at: Date },
    changes: BranchChanges
  ): Promise<BranchRecord | null>
  /** Removes the row. Its sandbox and its data are the caller's to remove first. */
  delete(input: BranchRef): Promise<boolean>
}
