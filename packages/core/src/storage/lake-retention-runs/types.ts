/** How the last automatic lake retention run ended. */
export interface LakeRetentionRunRecord {
  readonly projectId: string
  readonly finishedAt: Date
  /** Why stays with `onError`: this row reaches the API, and a driver's message can name secrets. */
  readonly failed: boolean
}

/**
 * The proof that a worker consumes retention requests: one row per project, which each run
 * rewrites. The API reads it from another process, since a queue says nothing of what it delivered.
 */
export interface LakeRetentionRunStorage {
  record(run: LakeRetentionRunRecord): Promise<void>
  getLast(input: { readonly projectId: string }): Promise<LakeRetentionRunRecord | null>
}
