import { LakeStorageError } from "@pario/core"
import type { DuckLakeStorageOptions } from "../types"
import {
  createDuckDbRuntime,
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

interface ReleaseWriteRuntimeOptions {
  readonly reuse: boolean
}

export interface DuckLakeCommittedWriteRuntimeRelease {
  readonly kind: "committed"
  readonly guarded: boolean
  readonly reusable: boolean
}

export type DuckLakeWriteRuntimeRelease =
  | DuckLakeCommittedWriteRuntimeRelease
  | { readonly kind: "aborted"; readonly reusable?: boolean }
  | { readonly kind: "failed" }

export interface DuckLakeWriteRuntimeLease {
  readonly runtime: DuckDbRuntime
  committedReadRuntime(release: DuckLakeCommittedWriteRuntimeRelease): Promise<DuckDbRuntime>
  release(result: DuckLakeWriteRuntimeRelease): Promise<void>
}

export interface DuckLakeWriteRuntimeLeaseResult<T> {
  readonly value: T
  readonly release: DuckLakeWriteRuntimeRelease
}

const MAX_IDLE_WRITE_RUNTIMES = 1

/**
 * Owns DuckDB/DuckLake runtime lifecycle for DuckLakeStorage.
 *
 * The shared runtime serves reads and metadata calls. Active writes receive
 * isolated runtime leases because DuckDB temp staging tables are
 * connection-scoped. Clean leases can be reused for catalog types that have
 * reliable cross-connection snapshot visibility.
 */
export class DuckLakeConnectionManager {
  private runtimePromise: Promise<DuckDbRuntime> | undefined
  private installExtensionsPromise: Promise<void> | undefined
  private readonly idleWriteRuntimes: DuckDbRuntime[] = []
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
   * Create a fresh initialized runtime. Setup work here is runtime-scoped:
   * extensions are loaded, secrets/setup SQL run, and the DuckLake catalog is
   * attached exactly once for this runtime.
   */
  async createRuntime(): Promise<DuckDbRuntime> {
    this.assertOpen()

    const runtime = await createDuckDbRuntime(this.options.duckdb)
    try {
      await this.ensureExtensionsInstalled(runtime)
      await setupDuckLake(runtime, this.options, { installExtensions: false })
      return runtime
    } catch (error) {
      await runtime.close()
      throw error
    }
  }

  async acquireWriteRuntime(): Promise<DuckDbRuntime> {
    this.assertOpen()

    const runtime = this.idleWriteRuntimes.pop()
    return runtime ?? this.createRuntime()
  }

  async acquireWriteLease(): Promise<DuckLakeWriteRuntimeLease> {
    return new ManagedDuckLakeWriteRuntimeLease(this, await this.acquireWriteRuntime())
  }

  async withWriteRuntime<T>(
    useLease: (
      lease: DuckLakeWriteRuntimeLease
    ) => DuckLakeWriteRuntimeLeaseResult<T> | Promise<DuckLakeWriteRuntimeLeaseResult<T>>
  ): Promise<T> {
    const lease = await this.acquireWriteLease()

    try {
      const result = await useLease(lease)
      await lease.release(result.release)
      return result.value
    } catch (error) {
      await lease.release({ kind: "failed" })
      throw error
    }
  }

  async releaseWriteRuntime(
    runtime: DuckDbRuntime,
    options: ReleaseWriteRuntimeOptions
  ): Promise<void> {
    if (
      this.closed ||
      !options.reuse ||
      !this.canReuseWriteRuntime() ||
      this.idleWriteRuntimes.length >= MAX_IDLE_WRITE_RUNTIMES
    ) {
      await runtime.close()
      return
    }

    this.idleWriteRuntimes.push(runtime)
  }

  canReuseWriteRuntime(): boolean {
    return canReuseWriteRuntimeForOptions(this.options)
  }

  private canRefreshReadRuntime(): boolean {
    return this.options.catalog.type === "postgres"
  }

  /**
   * Refresh the shared read/runtime connection after a write commits.
   *
   * DuckLake snapshot visibility is attached to the connection that loaded the
   * catalog. PostgreSQL catalogs can re-attach in place; local metadata files
   * need a fresh runtime to avoid stale or invalid file-backed catalog state.
   */
  async resetRuntime(): Promise<void> {
    const runtimePromise = this.runtimePromise
    if (runtimePromise === undefined) {
      return
    }

    if (!this.canRefreshReadRuntime()) {
      this.runtimePromise = undefined
      await this.closeRuntimePromise(runtimePromise)
      return
    }

    let refreshedPromise: Promise<DuckDbRuntime>
    refreshedPromise = runtimePromise
      .then(async (runtime) => {
        try {
          await this.refreshAttachedRuntime(runtime)
          return runtime
        } catch (error) {
          await runtime.close()
          throw error
        }
      })
      .catch((error) => {
        if (this.runtimePromise === refreshedPromise) {
          this.runtimePromise = undefined
        }
        throw error
      })

    this.runtimePromise = refreshedPromise
    await refreshedPromise
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }

    this.closed = true

    const idleWriteRuntimes = this.idleWriteRuntimes.splice(0)
    await this.closeRuntimePromise(this.runtimePromise)
    await Promise.all(idleWriteRuntimes.map((runtime) => runtime.close()))
    this.runtimePromise = undefined
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

  private async refreshAttachedRuntime(runtime: DuckDbRuntime): Promise<void> {
    await runtime.runStatements([
      `DETACH ${quoteIdentifier(duckLakeAlias(this.options))}`,
      buildAttachSql(this.options),
      ...(this.options.catalog.type === "postgres"
        ? [buildConfigurePostgresMetadataPoolSql(this.options)]
        : []),
    ])
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

function canReuseWriteRuntimeForOptions(options: DuckLakeStorageOptions): boolean {
  // Local DuckDB/SQLite metadata catalogs need the committing connection to
  // close before freshly attached read runtimes reliably observe the commit.
  // PostgreSQL catalogs provide cross-connection visibility without relying on
  // the writer connection closing, so they can safely keep one idle write lease.
  return options.catalog.type === "postgres"
}

class ManagedDuckLakeWriteRuntimeLease implements DuckLakeWriteRuntimeLease {
  private released = false

  constructor(
    private readonly connections: DuckLakeConnectionManager,
    readonly runtime: DuckDbRuntime
  ) {}

  async committedReadRuntime(
    release: DuckLakeCommittedWriteRuntimeRelease
  ): Promise<DuckDbRuntime> {
    await this.connections.resetRuntime()

    if (!this.connections.canReuseWriteRuntime()) {
      await this.release({ ...release, reusable: false })
    }

    return this.connections.runtime()
  }

  async release(result: DuckLakeWriteRuntimeRelease): Promise<void> {
    if (this.released) {
      return
    }

    this.released = true
    await this.connections.releaseWriteRuntime(this.runtime, {
      reuse: shouldReuseWriteRuntimeAfterRelease(result),
    })
  }
}

function shouldReuseWriteRuntimeAfterRelease(result: DuckLakeWriteRuntimeRelease): boolean {
  if (result.kind === "failed") {
    return false
  }

  if (result.kind === "aborted") {
    return result.reusable ?? true
  }

  return result.reusable && !result.guarded
}
