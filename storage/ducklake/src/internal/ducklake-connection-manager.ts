import { LakeStorageError } from "@pario/core"
import type { DuckLakeStorageOptions } from "../types"
import { createDuckDbRuntime, type DuckDbRuntime, setupDuckLake } from "./duckdb-runtime"

/**
 * Owns DuckDB/DuckLake runtime lifecycle for DuckLakeStorage.
 *
 * The shared runtime serves reads and metadata calls. Dedicated write runtimes
 * are created per write session because DuckDB temp staging tables are
 * connection-scoped.
 */
export class DuckLakeConnectionManager {
  private runtimePromise: Promise<DuckDbRuntime> | undefined
  private closed = false

  constructor(private readonly options: DuckLakeStorageOptions) {}

  assertOpen(): void {
    if (this.closed) {
      throw new LakeStorageError("[ParioDuckLake] DuckLakeStorage is closed.")
    }
  }

  async runtime(): Promise<DuckDbRuntime> {
    this.assertOpen()

    if (this.runtimePromise === undefined) {
      const runtimePromise = this.createRuntime().catch((error) => {
        if (this.runtimePromise === runtimePromise) {
          this.runtimePromise = undefined
        }
        throw error
      })
      this.runtimePromise = runtimePromise
    }

    return this.runtimePromise
  }

  /**
   * Create a fresh attached runtime. Write sessions use this directly so they
   * can keep connection-scoped staging tables isolated from shared reads.
   */
  async createRuntime(): Promise<DuckDbRuntime> {
    this.assertOpen()

    const runtime = await createDuckDbRuntime(this.options.duckdb)
    try {
      await setupDuckLake(runtime, this.options)
      return runtime
    } catch (error) {
      await runtime.close()
      throw error
    }
  }

  /**
   * Reconnect the shared read/runtime connection after a write commits.
   *
   * DuckLake snapshot visibility is attached to the connection that loaded the
   * catalog. A fresh runtime prevents latest-version and read queries from
   * observing stale metadata after a dedicated write connection commits.
   */
  async resetRuntime(): Promise<void> {
    const runtimePromise = this.runtimePromise
    this.runtimePromise = undefined

    await this.closeRuntimePromise(runtimePromise)
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }

    this.closed = true

    await this.closeRuntimePromise(this.runtimePromise)
    this.runtimePromise = undefined
  }

  private async closeRuntimePromise(
    runtimePromise: Promise<DuckDbRuntime> | undefined
  ): Promise<void> {
    if (runtimePromise === undefined) {
      return
    }

    let runtime: DuckDbRuntime
    try {
      runtime = await runtimePromise
    } catch {
      // createRuntime already closes partially-initialized runtimes before
      // rejecting. Swallowing here keeps close/reset idempotent after attach
      // failures while preserving the original operation error.
      return
    }

    await runtime.close()
  }
}
