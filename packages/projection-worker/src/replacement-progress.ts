import type { ProjectionMaterializationIdentity } from "@sixb/core/internal/materialization"
import type { ProjectionMaterializationRunStorage } from "@sixb/core/storage"
import { ProjectionWorkerError } from "./errors"

const DEFAULT_PROGRESS_FLUSH_INTERVAL = 500

/**
 * Reports absolute physical progress without making it a recovery cursor.
 *
 * A replacement retry starts reading from row zero. Persisted progress from an earlier attempt is
 * therefore treated as a floor until the deterministic replay reaches it again.
 */
export class ReplacementProgress {
  private sourceRowsRead = 0
  private sourceRowsSkipped = 0
  private lastFlushedRowsRead: number
  private lastFlushedRowsSkipped: number

  constructor(
    private readonly input: {
      readonly storage: ProjectionMaterializationRunStorage
      readonly projectId: string
      readonly projectionRunId: string
      readonly executionToken: string
      readonly identity: ProjectionMaterializationIdentity
      readonly persistedRowsRead: number
      readonly persistedRowsSkipped: number
      readonly expectedRows?: number
      readonly flushInterval?: number
    }
  ) {
    this.lastFlushedRowsRead = input.persistedRowsRead
    this.lastFlushedRowsSkipped = input.persistedRowsSkipped
  }

  async recordRow(skipped: boolean): Promise<void> {
    this.sourceRowsRead += 1
    if (skipped) this.sourceRowsSkipped += 1
    if (this.shouldFlush()) await this.flush()
  }

  async flush(): Promise<void> {
    if (!this.hasReachedPersistedFloor() || !this.hasNewProgress()) return
    const run = await this.input.storage.updateMaterialization({
      projectId: this.input.projectId,
      id: this.input.projectionRunId,
      executionToken: this.input.executionToken,
      identity: this.input.identity,
      sourceRowsRead: this.sourceRowsRead,
      sourceRowsSkipped: this.sourceRowsSkipped,
    })
    this.lastFlushedRowsRead = run.sourceRowsRead
    this.lastFlushedRowsSkipped = run.sourceRowsSkipped
  }

  assertComplete(): void {
    if (this.input.expectedRows !== undefined && this.sourceRowsRead !== this.input.expectedRows) {
      throw new ProjectionWorkerError(
        `[SixbProjectionWorker] Projection run '${this.input.projectionRunId}' reached EOF after ${this.sourceRowsRead} of ${this.input.expectedRows} pinned rows.`
      )
    }
    if (this.hasReachedPersistedFloor()) return
    throw new ProjectionWorkerError(
      `[SixbProjectionWorker] Projection run '${this.input.projectionRunId}' reached EOF before its persisted progress floor (${this.sourceRowsRead}/${this.input.persistedRowsRead} rows, ${this.sourceRowsSkipped}/${this.input.persistedRowsSkipped} skipped).`
    )
  }

  private shouldFlush(): boolean {
    const interval = this.input.flushInterval ?? DEFAULT_PROGRESS_FLUSH_INTERVAL
    return this.sourceRowsRead % interval === 0
  }

  private hasReachedPersistedFloor(): boolean {
    return (
      this.sourceRowsRead >= this.input.persistedRowsRead &&
      this.sourceRowsSkipped >= this.input.persistedRowsSkipped
    )
  }

  private hasNewProgress(): boolean {
    return (
      this.sourceRowsRead > this.lastFlushedRowsRead ||
      this.sourceRowsSkipped > this.lastFlushedRowsSkipped
    )
  }
}
