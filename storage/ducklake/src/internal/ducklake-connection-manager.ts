import { LakeStorageError } from "@pario/core"
import type { DuckLakeStorageOptions } from "../types"
import { localCatalogCoordinationKey } from "./catalog-key"
import {
  createDuckDbRuntime,
  type DuckDbExclusiveRuntime,
  type DuckDbQueryRuntime,
  type DuckDbRuntime,
  installDuckLakeExtensions,
  setupDuckLake,
} from "./duckdb-runtime"
import {
  buildAttachSql,
  buildConfigurePostgresMetadataPoolSql,
  duckLakeAlias,
  quoteIdentifier,
} from "./sql"

export interface DuckLakeAttachedRuntimeLease {
  readonly runtime: DuckDbRuntime
  release(): Promise<void>
}

/**
 * Owns DuckDB/DuckLake runtime lifecycle for DuckLakeStorage.
 *
 * A storage instance owns one DuckDB runtime and at most one DuckLake
 * attachment. The runtime starts unattached so construction and non-lake setup
 * do not immediately open DuckLake metadata connections; reads and commits
 * attach lazily through `attachedRuntime()`.
 */
export class DuckLakeConnectionManager {
  private runtimePromise: Promise<DuckDbRuntime> | undefined
  private installExtensionsPromise: Promise<void> | undefined
  private attachPromise: Promise<void> | undefined
  private refreshPromise: Promise<void> | undefined
  // Local catalogs need DETACH/ATTACH to refresh metadata visibility. Keep
  // those attachment changes outside whole read operations so a read cannot
  // observe the DuckLake alias disappearing between its metadata queries.
  private localAttachmentLock: Promise<void> = Promise.resolve()
  private observedLocalCatalogGeneration: number
  private attached = false
  private closed = false
  private runtimePoisoned = false

  constructor(private readonly options: DuckLakeStorageOptions) {
    this.observedLocalCatalogGeneration = currentLocalCatalogGeneration(options)
  }

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

  async attachedRuntime(): Promise<DuckDbRuntime> {
    const runtime = await this.runtime()
    await this.ensureAttached(runtime)
    return runtime
  }

  async withAttachedRuntime<T>(run: (runtime: DuckDbRuntime) => Promise<T>): Promise<T> {
    const lease = await this.acquireAttachedRuntime()
    try {
      return await run(lease.runtime)
    } finally {
      await lease.release()
    }
  }

  async acquireAttachedRuntime(): Promise<DuckLakeAttachedRuntimeLease> {
    this.assertOpen()

    // The lease is intentionally wider than one DuckDB queue operation. It
    // covers the full Pario read/commit boundary for local catalogs while
    // remaining a no-op for PostgreSQL catalogs.
    const releaseLock = await this.acquireLocalAttachmentLock()
    let released = false
    const release = async () => {
      if (released) {
        return
      }

      released = true
      try {
        if (this.runtimePoisoned) {
          this.runtimePoisoned = false
          await this.discardRuntimeUnlocked()
        } else {
          await this.detachDuckDbCatalogAfterLease()
        }
      } finally {
        releaseLock()
      }
    }

    try {
      await this.refreshForExternalChangesUnlocked()
      const runtime = await this.attachedRuntime()
      return { runtime, release }
    } catch (error) {
      await release()
      throw error
    }
  }

  async withExclusiveAttached<T>(run: (runtime: DuckDbExclusiveRuntime) => Promise<T>): Promise<T> {
    const lease = await this.acquireAttachedRuntime()
    try {
      return await lease.runtime.withExclusive(run)
    } finally {
      await lease.release()
    }
  }

  async stagingRuntime(): Promise<DuckDbRuntime> {
    const runtime = await this.runtime()

    if (this.options.catalog.type !== "postgres") {
      // Local catalogs can keep stale attached metadata when another provider
      // commits while this write session is open. Stage rows unattached so the
      // later exclusive commit attaches fresh without losing temp tables.
      await this.detachRuntime()
    }

    return runtime
  }

  /**
   * Create the one runtime owned by this manager. Setup loads extensions,
   * secrets, setup SQL, and pre-attach Postgres pool settings, but deliberately
   * leaves DuckLake unattached until `attachedRuntime()` is needed.
   */
  async createRuntime(): Promise<DuckDbRuntime> {
    this.assertOpen()

    const runtime = await createDuckDbRuntime(this.options.duckdb)
    try {
      await this.ensureExtensionsInstalled(runtime)
      await setupDuckLake(runtime, this.options, {
        attach: false,
        installExtensions: false,
      })
      return runtime
    } catch (error) {
      await this.closeRuntime(runtime, { detach: false })
      throw error
    }
  }

  async resetRuntime(): Promise<void> {
    const releaseLock = await this.acquireLocalAttachmentLock()
    try {
      await this.resetRuntimeUnlocked()
    } finally {
      releaseLock()
    }
  }

  private async resetRuntimeUnlocked(): Promise<void> {
    const runtimePromise = this.runtimePromise
    if (runtimePromise === undefined) {
      return
    }

    if (this.attachPromise !== undefined) {
      await this.attachPromise
    }

    if (!this.attached) {
      return
    }

    let refreshedPromise: Promise<DuckDbRuntime>
    refreshedPromise = runtimePromise
      .then(async (runtime) => {
        try {
          await this.refreshAttachedRuntime(runtime)
          this.attached = true
          return runtime
        } catch (error) {
          this.attached = false
          await this.closeRuntime(runtime, { detach: false })
          throw error
        }
      })
      .catch((error) => {
        if (this.runtimePromise === refreshedPromise) {
          this.runtimePromise = undefined
        }
        throw error
      })

    this.attached = false
    this.runtimePromise = refreshedPromise
    await refreshedPromise
  }

  async refreshForExternalChanges(): Promise<void> {
    if (this.options.catalog.type === "postgres") {
      return
    }

    if (!this.needsLocalCatalogRefresh()) {
      return
    }

    if (this.refreshPromise === undefined) {
      let refreshPromise: Promise<void>
      refreshPromise = this.withLocalAttachmentLock(() =>
        this.refreshForExternalChangesUnlocked()
      ).finally(() => {
        if (this.refreshPromise === refreshPromise) {
          this.refreshPromise = undefined
        }
      })
      this.refreshPromise = refreshPromise
    }

    await this.refreshPromise
  }

  markLocalCatalogChanged(): void {
    if (this.options.catalog.type === "postgres") {
      return
    }

    this.observedLocalCatalogGeneration = incrementLocalCatalogGeneration(this.options)
  }

  async detachLocalCatalogAfterCommit(runtime: DuckDbQueryRuntime): Promise<void> {
    if (this.options.catalog.type === "postgres") {
      return
    }

    try {
      await runtime.run(`DETACH ${quoteIdentifier(duckLakeAlias(this.options))}`)
      this.attached = false
    } catch {
      // The commit already succeeded. Keep the original write result and let a
      // later refresh/close retry detaching this local catalog if needed.
    } finally {
      this.markLocalCatalogChanged()
    }
  }

  private async refreshForExternalChangesUnlocked(): Promise<void> {
    const generation = currentLocalCatalogGeneration(this.options)
    if (this.observedLocalCatalogGeneration === generation) {
      return
    }

    await this.resetRuntimeUnlocked()

    this.observedLocalCatalogGeneration = generation
  }

  private needsLocalCatalogRefresh(): boolean {
    return this.observedLocalCatalogGeneration !== currentLocalCatalogGeneration(this.options)
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }

    this.closed = true

    const runtimePromise = this.runtimePromise
    this.runtimePromise = undefined
    await this.closeRuntimePromise(runtimePromise, {
      // For Postgres catalogs, the DuckDB Postgres extension owns the attached
      // pool. Explicit DETACH can briefly create or retain another backend;
      // closing the DuckDB runtime is the tighter shutdown path.
      detach: this.attached && this.options.catalog.type !== "postgres",
    })
    this.attached = false
  }

  private async ensureAttached(runtime: DuckDbRuntime): Promise<void> {
    this.assertOpen()

    if (this.attached) {
      return
    }

    if (this.attachPromise === undefined) {
      let attachPromise: Promise<void>
      attachPromise = this.attachRuntime(runtime)
        .then(() => {
          this.attached = true
        })
        .catch(async (error) => {
          if (this.attachPromise === attachPromise) {
            this.runtimePromise = undefined
            this.attached = false
          }
          await this.closeRuntime(runtime, { detach: false })
          throw error
        })
        .finally(() => {
          if (this.attachPromise === attachPromise) {
            this.attachPromise = undefined
          }
        })
      this.attachPromise = attachPromise
    }

    await this.attachPromise
  }

  private async ensureExtensionsInstalled(runtime: DuckDbRuntime): Promise<void> {
    if (this.installExtensionsPromise === undefined) {
      const installExtensionsPromise = installDuckLakeExtensions(runtime, this.options).catch(
        (error) => {
          if (this.installExtensionsPromise === installExtensionsPromise) {
            this.installExtensionsPromise = undefined
          }
          throw error
        }
      )
      this.installExtensionsPromise = installExtensionsPromise
    }

    await this.installExtensionsPromise
  }

  private async attachRuntime(runtime: DuckDbRuntime): Promise<void> {
    await runtime.runStatements([
      buildAttachSql(this.options),
      ...(this.options.catalog.type === "postgres"
        ? [buildConfigurePostgresMetadataPoolSql(this.options)]
        : []),
    ])
  }

  private async refreshAttachedRuntime(runtime: DuckDbRuntime): Promise<void> {
    await runtime.runStatements([
      `DETACH ${quoteIdentifier(duckLakeAlias(this.options))}`,
      buildAttachSql(this.options),
      ...(this.options.catalog.type === "postgres"
        ? [buildConfigurePostgresMetadataPoolSql(this.options)]
        : []),
    ])
  }

  private async detachRuntime(): Promise<void> {
    await this.withLocalAttachmentLock(() => this.detachRuntimeUnlocked())
  }

  /**
   * Mark the active runtime as unusable for reuse. The next lease release
   * discards the connection so session state that could not be cleaned up
   * (such as a SET pragma whose RESET failed) cannot reach a later operation.
   */
  poisonRuntime(): void {
    this.runtimePoisoned = true
  }

  private async detachDuckDbCatalogAfterLease(): Promise<void> {
    if (this.options.catalog.type !== "duckdb" || !this.attached) {
      return
    }

    try {
      await this.detachRuntimeUnlocked()
    } catch {
      // DuckDB-backed DuckLake catalogs are single-client local catalogs. If
      // cleanup cannot detach, discard this runtime so the next operation
      // starts from an unattached connection instead of keeping stale metadata.
      await this.discardRuntimeUnlocked()
    }
  }

  // Close and forget the current runtime so the next `runtime()` builds a fresh
  // connection with default session state. Unlike `resetRuntimeUnlocked()`,
  // which DETACH/ATTACHes the same connection, this drops the connection
  // entirely -- the only way to clear a leaked session pragma.
  private async discardRuntimeUnlocked(): Promise<void> {
    const runtimePromise = this.runtimePromise
    this.runtimePromise = undefined
    this.attached = false
    await this.closeRuntimePromise(runtimePromise, { detach: false }).catch(() => {})
  }

  private async detachRuntimeUnlocked(): Promise<void> {
    if (this.attachPromise !== undefined) {
      await this.attachPromise
    }

    if (!this.attached) {
      return
    }

    const runtime = await this.runtime()
    await runtime.run(`DETACH ${quoteIdentifier(duckLakeAlias(this.options))}`)
    this.attached = false
  }

  private async withLocalAttachmentLock<T>(run: () => Promise<T>): Promise<T> {
    const releaseLock = await this.acquireLocalAttachmentLock()
    try {
      return await run()
    } finally {
      releaseLock()
    }
  }

  private async acquireLocalAttachmentLock(): Promise<() => void> {
    if (this.options.catalog.type === "postgres") {
      return () => {}
    }

    const previous = this.localAttachmentLock.catch(() => {})
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    this.localAttachmentLock = previous.then(() => current)

    await previous

    let released = false
    return () => {
      if (released) {
        return
      }

      released = true
      release()
    }
  }

  private async closeRuntimePromise(
    runtimePromise: Promise<DuckDbRuntime> | undefined,
    options: { readonly detach: boolean }
  ): Promise<void> {
    if (runtimePromise === undefined) {
      return
    }

    let runtime: DuckDbRuntime
    try {
      runtime = await runtimePromise
    } catch {
      // createRuntime/attachRuntime already close partially-initialized
      // runtimes before rejecting. Swallowing here keeps close/reset
      // idempotent while preserving the original operation error.
      return
    }

    await this.closeRuntime(runtime, options)
  }

  private async closeRuntime(
    runtime: DuckDbRuntime,
    options: { readonly detach: boolean }
  ): Promise<void> {
    if (options.detach) {
      try {
        await runtime.run(`DETACH ${quoteIdentifier(duckLakeAlias(this.options))}`)
      } catch {
        // The runtime may already be detached, partially initialized, or in an
        // error state. Closing the native connection is still required.
      }
    }

    await runtime.close()
  }
}

// Local catalog tests commonly create multiple DuckLakeStorage instances in one
// process. DuckLake/Postgres handles cross-connection visibility itself; local
// file catalogs need this in-process signal so peers refresh after Pario writes.
const localCatalogGenerations = new Map<string, number>()

function currentLocalCatalogGeneration(options: DuckLakeStorageOptions): number {
  const key = localCatalogCoordinationKey(options)
  return key === undefined ? 0 : (localCatalogGenerations.get(key) ?? 0)
}

function incrementLocalCatalogGeneration(options: DuckLakeStorageOptions): number {
  const key = localCatalogCoordinationKey(options)
  if (key === undefined) {
    return 0
  }

  const nextGeneration = (localCatalogGenerations.get(key) ?? 0) + 1
  localCatalogGenerations.set(key, nextGeneration)
  return nextGeneration
}
