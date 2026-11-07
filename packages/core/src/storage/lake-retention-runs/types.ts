/** The last automatic lake retention run. */
export interface LakeRetentionRunRecord {
  readonly projectId: string
  readonly startedAt: Date
  /** Null while it runs. */
  readonly finishedAt: Date | null
  /** Why stays with `onError`: this row reaches the API, and a driver's message can name secrets. */
  readonly failed: boolean
}

/**
 * The proof that a worker consumes retention requests: one row per project, which each run
 * rewrites as it starts and as it ends. The API reads it from another process, since a queue says
 * nothing of what it delivered.
 */
export interface LakeRetentionRunStorage {
  record(run: LakeRetentionRunRecord): Promise<void>
  getLast(input: { readonly projectId: string }): Promise<LakeRetentionRunRecord | null>
}
