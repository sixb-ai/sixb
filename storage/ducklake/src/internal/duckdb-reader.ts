import type { DuckDBConnection, DuckDBResult } from "@duckdb/node-api"
import { LakeStorageError } from "@sixb/core/lake-storage"
import { sixbDuckDbValueConverter } from "./duckdb-value-converter"

/** One native query, on a connection belonging to the runtime's shared instance. */
export interface DuckDbReader {
  rows(): AsyncIterable<Record<string, unknown>>
  close(): Promise<void>
}

export interface DuckDbReaderOptions {
  readonly signal?: AbortSignal
  readonly onClose?: () => Promise<void>
}

export class NodeDuckDbReader implements DuckDbReader {
  private resultPromise: Promise<DuckDBResult> | undefined
  private pending: Promise<unknown> | undefined
  private closePromise: Promise<void> | undefined
  private finished = false
  private consumed = false
  private readonly onAbort = () => {
    // Keep the rejected cleanup observable through close()/rows(), including when the consumer
    // is paused. The event listener itself cannot return an awaited promise.
    void this.close().catch(() => {})
  }

  constructor(
    private readonly connection: DuckDBConnection,
    private readonly options: DuckDbReaderOptions
  ) {}

  async start(sql: string): Promise<void> {
    this.options.signal?.throwIfAborted()
    this.options.signal?.addEventListener("abort", this.onAbort, { once: true })
    // Connection-local settings are not inherited by a new connection. Physical offsets must
    // remain stable even when a dataset shadows DuckDB's virtual rowid column.
    await this.track(this.connection.run("SET preserve_insertion_order = true"))
    this.assertOpen()
    const prepared = await this.track(this.connection.prepare(sql))
    try {
      this.assertOpen()
      // Starting the pending query establishes its interruptible context synchronously. Avoid
      // connection.stream() starting execution after an abort that happened during preparation.
      this.resultPromise = this.track(prepared.startStream().getResult()).finally(() => {
        prepared.destroySync()
      })
      // Execute independently after preparation, so a large sort does not occupy the main queue
      // or attachment lease. rows() observes failures even if execution ends before consumption.
      void this.resultPromise.catch(() => {})
    } catch (error) {
      prepared.destroySync()
      throw error
    }
  }

  async *rows(): AsyncIterable<Record<string, unknown>> {
    if (this.consumed)
      throw new LakeStorageError("[SixbDuckLake] Reader can only be consumed once.")
    this.consumed = true
    try {
      this.assertOpen()
      const result = await this.resultPromise!
      this.assertOpen()
      const batches = result
        .yieldConvertedRowObjects(sixbDuckDbValueConverter)
        [Symbol.asyncIterator]()
      while (true) {
        this.assertOpen()
        const batch = await this.track(batches.next())
        this.assertOpen()
        if (batch.done) {
          this.finished = true
          return
        }
        for (const row of batch.value) {
          this.assertOpen()
          yield row as Record<string, unknown>
        }
      }
    } finally {
      await this.close()
    }
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.options.signal?.removeEventListener("abort", this.onAbort)
      if (this.pending) this.connection.interrupt()
      this.closePromise = this.finish()
    }
    return this.closePromise
  }

  private async finish(): Promise<void> {
    try {
      await this.pending?.catch(() => {})
      if (!this.finished) {
        // node-api 1.5.2 exposes no result.close(). Disconnect alone leaves a paused query's
        // transaction alive until GC. A new statement ends it without draining the whole result.
        await this.connection.run("SELECT 1")
      }
    } finally {
      this.resultPromise = undefined
      try {
        this.connection.closeSync()
      } finally {
        await this.options.onClose?.()
      }
    }
  }

  private async track<T>(operation: Promise<T>): Promise<T> {
    this.pending = operation
    try {
      return await operation
    } catch (error) {
      this.assertOpen()
      throw error
    } finally {
      if (this.pending === operation) this.pending = undefined
    }
  }

  private assertOpen(): void {
    this.options.signal?.throwIfAborted()
    if (this.closePromise) throw new LakeStorageError("[SixbDuckLake] Reader is closed.")
  }
}
