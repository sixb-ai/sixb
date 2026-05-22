import { type DuckDBConnection, DuckDBInstance, type DuckDBValue } from "@duckdb/node-api"
import { LakeStorageError } from "@pario/core"
import type { DuckDbRuntimeOptions, DuckLakeStorageOptions } from "../types"
import { buildAttachSql, buildCreateSecretSql, quoteIdentifier, requiredExtensions } from "./sql"

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
  private closed = false

  constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection
  ) {}

  async run(sql: string, values?: readonly DuckDBValue[]): Promise<void> {
    this.assertOpen()
    await this.connection.run(sql, values === undefined ? undefined : [...values])
  }

  async query(
    sql: string,
    values?: readonly DuckDBValue[]
  ): Promise<readonly Record<string, unknown>[]> {
    this.assertOpen()
    const reader = await this.connection.runAndReadAll(
      sql,
      values === undefined ? undefined : [...values]
    )
    return reader.getRowObjectsJS()
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }

    this.closed = true
    this.connection.closeSync()
    this.instance.closeSync()
  }

  private assertOpen(): void {
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
}
