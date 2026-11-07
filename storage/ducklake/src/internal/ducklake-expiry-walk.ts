import type { DuckLakeHistorySnapshot } from "./ducklake-snapshot-reader"

export interface ExpiryPlan {
  readonly expirable: readonly string[]
  readonly keptVersions: number
  readonly hasMore: boolean
}

interface ExpiryWalkInput {
  /** The newest snapshot, which DuckLake never expires. */
  readonly head: string
  readonly protect: ReadonlySet<string>
  /** How many expirable snapshots end the walk. */
  readonly limit: number
}

/**
 * One walk up the history, oldest first, that stops at the retention cutoff or once `limit`
 * snapshots are expirable.
 *
 * A snapshot holding no version, such as a maintenance commit, expires once it is past the cutoff.
 * A version expires once the next version of its dataset is past the cutoff too: within the walk,
 * every version of a dataset but the last. That last one, a dataset's latest version or one
 * replaced too recently, stays. Each pass starts again from the oldest snapshot left, and only
 * those kept versions stand before the ones it can expire.
 */
export class ExpiryWalk {
  private readonly expirable: string[] = []
  private keptVersions = 0

  /** The last version seen of each dataset. */
  private readonly lastVersionOf = new Map<string, string>()

  /** For how many datasets a snapshot still is the last version seen. */
  private readonly datasetsStillLast = new Map<string, number>()

  constructor(private readonly input: ExpiryWalkInput) {}

  /** Visits a page of history, and says why the walk ends there, if it does. */
  visitPage(page: readonly DuckLakeHistorySnapshot[]): "cutoff" | "limit" | null {
    for (const snapshot of page) {
      if (!snapshot.beforeCutoff) {
        return "cutoff"
      }

      this.visit(snapshot)

      if (this.expirable.length >= this.input.limit) {
        return "limit"
      }
    }

    return null
  }

  plan(hasMore: boolean): ExpiryPlan {
    return { expirable: this.expirable, keptVersions: this.keptVersions, hasMore }
  }

  private visit(snapshot: DuckLakeHistorySnapshot): void {
    if (snapshot.versionOf.length === 0) {
      if (snapshot.snapshotId !== this.input.head) {
        this.expirable.push(snapshot.snapshotId)
      }
      return
    }

    this.datasetsStillLast.set(snapshot.snapshotId, snapshot.versionOf.length)

    for (const datasetId of snapshot.versionOf) {
      const previous = this.lastVersionOf.get(datasetId)
      this.lastVersionOf.set(datasetId, snapshot.snapshotId)

      if (previous !== undefined) {
        this.supersede(previous)
      }
    }
  }

  /** A snapshot goes once every dataset it was the last version of has a newer one. */
  private supersede(snapshotId: string): void {
    const remaining = (this.datasetsStillLast.get(snapshotId) ?? 1) - 1
    if (remaining > 0) {
      this.datasetsStillLast.set(snapshotId, remaining)
      return
    }

    this.datasetsStillLast.delete(snapshotId)

    if (this.input.protect.has(snapshotId)) {
      this.keptVersions++
    } else {
      this.expirable.push(snapshotId)
    }
  }
}
