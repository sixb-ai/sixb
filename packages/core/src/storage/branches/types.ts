/** Where a branch's runtime is: stopped, starting in its sandbox, serving, or failed to serve. */
export type BranchState = "stopped" | "starting" | "ready" | "failed"

/** Why a branch's runtime isn't serving, with the project file the error points at. */
export interface BranchError {
  readonly message: string
  readonly file?: string
}

/**
 * A git branch of the project with a runtime of its own: `sixb dev --branch` in a sandbox that the
 * row owns, as a run owns its thread's. Whoever wants it running says so in `wanted`; the worker
 * holding the lease works toward it and writes what it finds.
 */
export interface BranchRecord {
  readonly projectId: string
  /** The git branch. */
  readonly name: string
  readonly wanted: "running" | "stopped"
  readonly state: BranchState
  /** What the runtime asks every request for. Only this project's server sends it. */
  readonly key: string
  /** The sandbox port the runtime listens on. */
  readonly port: number
  /** The sandbox provider's name for its saved state, once it has been opened. */
  readonly sandbox: string | null
  /** Where this project's server reaches the runtime, while it runs. */
  readonly url: string | null
  /** The runtime's generation: each change that reaches its checkout starts a new one. */
  readonly generation: number | null
  /** The checkout's commit the runtime serves. */
  readonly commit: string | null
  /** The runtime's definitions manifest hash, while it serves. */
  readonly manifest: string | null
  readonly error: BranchError | null
  /** When a push was last reported. The runtime pulls while this is newer than `pulledAt`. */
  readonly pushedAt: Date | null
  readonly pulledAt: Date | null
  /** The worker holding the branch's sandbox, until `leaseExpiresAt`. */
  readonly owner: string | null
  readonly leaseExpiresAt: Date | null
  readonly createdBy: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
  /** When someone last reached the runtime. A branch nobody reaches stops. */
  readonly lastSeenAt: Date
  /** Grows by one with every write: `update` compares it to tell a stale write from a fresh one. */
  readonly revision: number
}

/** What a write may change: everything but the identity and the bookkeeping. */
export type BranchChanges = Partial<
  Omit<BranchRecord, "projectId" | "name" | "createdAt" | "createdBy" | "updatedAt" | "revision">
>

export interface BranchStorage {
  get(input: { readonly projectId: string; readonly name: string }): Promise<BranchRecord | null>
  /** Every branch of the project, by name. */
  list(input: { readonly projectId: string }): Promise<readonly BranchRecord[]>
  /** Adds the branch at revision 1. A name already taken returns that branch, unchanged. */
  create(
    record: Omit<BranchRecord, "updatedAt" | "revision">
  ): Promise<{ readonly branch: BranchRecord; readonly created: boolean }>
  /**
   * Writes `changes` when the branch is still at `revision`, and returns it as written; `null`
   * when it moved on or is gone. Without `revision` it writes over whatever is there.
   */
  update(
    input: {
      readonly projectId: string
      readonly name: string
      readonly revision?: number
      readonly at: Date
    },
    changes: BranchChanges
  ): Promise<BranchRecord | null>
  /** Removes the branch's row. Whatever sandbox it held is the caller's to remove first. */
  delete(input: { readonly projectId: string; readonly name: string }): Promise<boolean>
}
