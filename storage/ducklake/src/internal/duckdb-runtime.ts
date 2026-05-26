import { type DuckDBConnection, DuckDBInstance, type DuckDBValue } from "@duckdb/node-api"
import { LakeStorageError } from "@pario/core"
import type { DuckDbRuntimeOptions, DuckLakeStorageOptions } from "../types"
import {
  buildAttachSql,
  buildConfigurePostgresMetadataPoolSql,
  buildCreateSecretSql,
  quoteIdentifier,
  requiredExtensions,
} from "./sql"

/**
 * Narrow adapter around `@duckdb/node-api`.
 *
 * Keeping the public provider behind this interface lets later slices add
 * appender/query helpers without leaking driver types into `DuckLakeStorage`.
 */
export interface DuckDbRuntime {
  run(sql: string, values?: readonly DuckDBValue[]): Promise<void>
  query(sql: string, values?: readonly DuckDBValue[]): Promise<readonly Record<string, unknown>[]>
  close(): Promise<void>
}

class NodeDuckDbRuntime implements DuckDbRuntime {
  private closing = false
  private closed = false
  // One DuckDBConnection is shared by the runtime. Serialize calls so request
  // handlers cannot interleave statements or close/reset an active query.
  private operations: Promise<void> = Promise.resolve()

  constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection
  ) {}

  async run(sql: string, values?: readonly DuckDBValue[]): Promise<void> {
    await this.enqueue(async () => {
      await this.connection.run(sql, values === undefined ? undefined : [...values])
    })
  }

  async query(
    sql: string,
    values?: readonly DuckDBValue[]
  ): Promise<readonly Record<string, unknown>[]> {
    return this.enqueue(async () => {
      const reader = await this.connection.runAndReadAll(
        sql,
        values === undefined ? undefined : [...values]
      )
      return reader.getRowObjectsJS()
    })
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }

    this.closing = true
    // resetRuntime()/close() can run while an API read is still using this
    // runtime. Wait for accepted work before closing the native connection.
    await this.operations.catch(() => {})
    this.closed = true
    this.connection.closeSync()
    this.instance.closeSync()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.assertAcceptingOperations()

    // Keep the chain alive after failures so one rejected query does not block
    // all later work on this runtime.
    const result = this.operations.then(async () => {
      this.assertNotClosed()
      return operation()
    })
    this.operations = result.then(
      () => {},
      () => {}
    )
    return result
  }

  private assertAcceptingOperations(): void {
    if (this.closing || this.closed) {
      throw new LakeStorageError("[ParioDuckLake] DuckDB runtime is closed.")
    }
  }

  private assertNotClosed(): void {
    if (this.closed) {
      throw new LakeStorageError("[ParioDuckLake] DuckDB runtime is closed.")
    }
  }
}

/**
 * Create the DuckDB runtime used by the provider.
 */
export async function createDuckDbRuntime(
  options: DuckDbRuntimeOptions = {}
): Promise<DuckDbRuntime> {
  const instance = await DuckDBInstance.create(options.path ?? ":memory:", options.config ?? {})
  return new NodeDuckDbRuntime(instance, await instance.connect())
}

/**
 * Install/load DuckLake, install/load catalog extensions, run caller setup SQL,
 * and attach the configured DuckLake catalog.
 */
export async function setupDuckLake(
  runtime: DuckDbRuntime,
  options: DuckLakeStorageOptions
): Promise<void> {
  await runtime.run("INSTALL ducklake")
  await runtime.run("LOAD ducklake")

  for (const extension of requiredExtensions(options)) {
    await runtime.run(`INSTALL ${quoteIdentifier(extension)}`)
    await runtime.run(`LOAD ${quoteIdentifier(extension)}`)
  }

  for (const sql of options.setupSql ?? []) {
    await runtime.run(sql)
  }

  for (const secret of options.secrets ?? []) {
    await runtime.run(buildCreateSecretSql(secret))
  }

  await runtime.run(buildAttachSql(options))

  if (options.catalog.type === "postgres") {
    await runtime.run(buildConfigurePostgresMetadataPoolSql(options))
  }
}
