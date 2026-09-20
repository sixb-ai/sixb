import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  type DuckDBConnection,
  DuckDBInstance,
  type DuckDBValue,
  type DuckDBAppender as NodeDuckDBAppender,
} from "@duckdb/node-api"
import { LakeStorageError } from "@sixb/core/lake-storage"
import type { DuckDbRuntimeOptions, DuckLakeStorageOptions } from "../types"
import { type DuckDbReader, type DuckDbReaderOptions, NodeDuckDbReader } from "./duckdb-reader"
import { sixbDuckDbValueConverter } from "./duckdb-value-converter"
import {
  buildAttachSql,
  buildConfigurePostgresMetadataPoolSql,
  buildCreateSecretSql,
  buildSetPostgresPoolSql,
  quoteIdentifier,
  requiredExtensions,
} from "./sql"

/**
 * Narrow adapter around `@duckdb/node-api`.
 *
 * Keeping the public provider behind this interface confines the driver types to
 * this module instead of leaking them into `DuckLakeStorage`. Main-connection calls
 * share one queue; readers use separate connections to the same DuckDB instance.
 */
export interface DuckDbQueryRuntime {
  run(sql: string, values?: readonly DuckDBValue[]): Promise<void>
  runStatements(statements: readonly string[]): Promise<void>
  query(sql: string, values?: readonly DuckDBValue[]): Promise<readonly Record<string, unknown>[]>
  withAppender<T>(
    tableName: string,
    useAppender: (appender: DuckDbAppender) => T | Promise<T>
  ): Promise<T>
}

export interface DuckDbRuntime extends DuckDbQueryRuntime {
  openReader(sql: string, options?: DuckDbReaderOptions): Promise<DuckDbReader>
  stopReaders(): Promise<void>
  /**
   * Reserve the runtime queue for a multi-statement critical section.
   *
   * Use this for sequences such as BEGIN/read metadata/write/COMMIT where an
   * interleaved read or write would observe the wrong connection state.
   */
  withExclusive<T>(useRuntime: (runtime: DuckDbExclusiveRuntime) => Promise<T>): Promise<T>
  close(): Promise<void>
}

/**
 * Runtime surface available while the caller already owns the queue slot.
 *
 * This is the query/appender subset only: no streaming, no close, and no nested
 * exclusive block.
 */
export type DuckDbExclusiveRuntime = DuckDbQueryRuntime

export interface DuckDbAppender {
  appendNull(): void
  appendBoolean(value: boolean): void
  appendVarchar(value: string): void
  appendBigInt(value: bigint): void
  appendDouble(value: number): void
  appendStruct(value: Readonly<Record<string, DuckDBValue>>): void
  endRow(): void
}

interface SetupDuckLakeOptions {
  readonly installExtensions?: boolean
  readonly attach?: boolean
}

class NodeDuckDbRuntime implements DuckDbRuntime {
  private closing = false
  private closed = false
  // Serialize main-connection calls so transactions and staged writes cannot interleave.
  private operations: Promise<void> = Promise.resolve()
  private readonly readers = new Set<DuckDbReader>()
  private closePromise: Promise<void> | undefined

  constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
    private readonly temporaryDirectory?: string
  ) {}

  async openReader(sql: string, options: DuckDbReaderOptions = {}): Promise<DuckDbReader> {
    return this.enqueue(async () => {
      this.assertAcceptingOperations()
      const connection = await this.instance.connect()
      if (this.closing) {
        connection.closeSync()
        this.assertAcceptingOperations()
      }
      const reader = new NodeDuckDbReader(connection, {
        ...options,
        onClose: async () => {
          this.readers.delete(reader)
          await options.onClose?.()
        },
      })
      this.readers.add(reader)
      try {
        await reader.start(sql)
        return reader
      } catch (error) {
        await reader.close()
        throw error
      }
    })
  }

  async run(sql: string, values?: readonly DuckDBValue[]): Promise<void> {
    await this.enqueue(async () => {
      await this.connection.run(sql, values === undefined ? undefined : [...values])
    })
  }

  async runStatements(statements: readonly string[]): Promise<void> {
    await this.enqueue(async () => {
      for (const sql of statements) {
        await this.connection.run(sql)
      }
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
      return reader.convertRowObjects(sixbDuckDbValueConverter)
    })
  }

  async withAppender<T>(
    tableName: string,
    useAppender: (appender: DuckDbAppender) => T | Promise<T>
  ): Promise<T> {
    return this.enqueue(async () => {
      const appender = await this.connection.createAppender(tableName)
      try {
        return await useAppender(new NodeDuckDbAppenderAdapter(appender))
      } finally {
        appender.closeSync()
      }
    })
  }

  async withExclusive<T>(useRuntime: (runtime: DuckDbExclusiveRuntime) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      // The exclusive adapter talks directly to the underlying connection while
      // this queued operation is active. Do not pass `this` into the callback.
      return useRuntime(new NodeDuckDbExclusiveRuntime(this.connection))
    })
  }

  close(): Promise<void> {
    this.closePromise ??= this.finish()
    return this.closePromise
  }

  async stopReaders(): Promise<void> {
    const results = await Promise.allSettled([...this.readers].map((reader) => reader.close()))
    const failed = results.find((result) => result.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason
  }

  private async finish(): Promise<void> {
    this.closing = true
    const results = await Promise.allSettled([...this.readers].map((reader) => reader.close()))
    // resetRuntime()/close() can run while an API read is still using this
    // runtime. Wait for accepted work before closing the native connection.
    await this.operations.catch(() => {})
    this.closed = true
    this.connection.closeSync()
    this.instance.closeSync()
    if (this.temporaryDirectory) await rm(this.temporaryDirectory, { recursive: true, force: true })
    const failed = results.find((result) => result.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
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
      throw new LakeStorageError("[SixbDuckLake] DuckDB runtime is closed.")
    }
  }

  private assertNotClosed(): void {
    if (this.closed) {
      throw new LakeStorageError("[SixbDuckLake] DuckDB runtime is closed.")
    }
  }
}

class NodeDuckDbExclusiveRuntime implements DuckDbExclusiveRuntime {
  constructor(private readonly connection: DuckDBConnection) {}

  async run(sql: string, values?: readonly DuckDBValue[]): Promise<void> {
    await this.connection.run(sql, values === undefined ? undefined : [...values])
  }

  async runStatements(statements: readonly string[]): Promise<void> {
    for (const sql of statements) {
      await this.connection.run(sql)
    }
  }

  async query(
    sql: string,
    values?: readonly DuckDBValue[]
  ): Promise<readonly Record<string, unknown>[]> {
    const reader = await this.connection.runAndReadAll(
      sql,
      values === undefined ? undefined : [...values]
    )
    return reader.convertRowObjects(sixbDuckDbValueConverter)
  }

  async withAppender<T>(
    tableName: string,
    useAppender: (appender: DuckDbAppender) => T | Promise<T>
  ): Promise<T> {
    const appender = await this.connection.createAppender(tableName)
    try {
      return await useAppender(new NodeDuckDbAppenderAdapter(appender))
    } finally {
      appender.closeSync()
    }
  }
}

class NodeDuckDbAppenderAdapter implements DuckDbAppender {
  constructor(private readonly appender: NodeDuckDBAppender) {}

  appendNull(): void {
    this.appender.appendNull()
  }

  appendBoolean(value: boolean): void {
    this.appender.appendBoolean(value)
  }

  appendVarchar(value: string): void {
    this.appender.appendVarchar(value)
  }

  appendBigInt(value: bigint): void {
    this.appender.appendBigInt(value)
  }

  appendDouble(value: number): void {
    this.appender.appendDouble(value)
  }

  appendStruct(value: Readonly<Record<string, DuckDBValue>>): void {
    this.appender.appendStruct(value)
  }

  endRow(): void {
    this.appender.endRow()
  }
}

/**
 * Create the DuckDB runtime used by the provider.
 */
export async function createDuckDbRuntime(
  options: DuckDbRuntimeOptions = {}
): Promise<DuckDbRuntime> {
  const path = options.path ?? ":memory:"
  const base = options.config?.temp_directory ?? (path === ":memory:" ? ".tmp" : `${path}.tmp`)
  // DuckDB's default .tmp filenames collide between independent instances/processes. Keep the
  // configured disk location, but give each runtime its own directory and cleanup ownership.
  let temporaryDirectory: string | undefined
  if (base !== "") {
    const directory = resolve(base)
    await mkdir(directory, { recursive: true })
    temporaryDirectory = await mkdtemp(join(directory, "sixb-"))
  }
  let instance: DuckDBInstance | undefined
  try {
    instance = await DuckDBInstance.create(path, {
      ...options.config,
      ...(temporaryDirectory ? { temp_directory: temporaryDirectory } : {}),
    })
    return new NodeDuckDbRuntime(instance, await instance.connect(), temporaryDirectory)
  } catch (error) {
    instance?.closeSync()
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
    throw error
  }
}

/**
 * Install DuckLake and any catalog/data-path extensions into DuckDB's local
 * extension directory. Installation is idempotent and can be shared by many
 * short-lived runtimes created by one provider instance.
 */
export async function installDuckLakeExtensions(
  runtime: DuckDbRuntime,
  options: DuckLakeStorageOptions
): Promise<void> {
  await runtime.run("INSTALL ducklake")

  for (const extension of requiredExtensions(options)) {
    await runtime.run(`INSTALL ${quoteIdentifier(extension)}`)
  }
}

/**
 * Load DuckLake, load catalog extensions, run caller setup SQL, and optionally
 * attach the configured DuckLake catalog.
 */
export async function setupDuckLake(
  runtime: DuckDbRuntime,
  options: DuckLakeStorageOptions,
  setupOptions: SetupDuckLakeOptions = {}
): Promise<void> {
  if (setupOptions.installExtensions ?? true) {
    await installDuckLakeExtensions(runtime, options)
  }

  await runtime.run("LOAD ducklake")

  for (const extension of requiredExtensions(options)) {
    await runtime.run(`LOAD ${quoteIdentifier(extension)}`)
  }

  for (const sql of options.setupSql ?? []) {
    await runtime.run(sql)
  }

  if (options.catalog.type === "postgres") {
    await runtime.runStatements(buildSetPostgresPoolSql(options))
  }

  for (const secret of options.secrets ?? []) {
    await runtime.run(buildCreateSecretSql(secret))
  }

  if (setupOptions.attach ?? true) {
    await runtime.run(buildAttachSql(options))

    if (options.catalog.type === "postgres") {
      await runtime.run(buildConfigurePostgresMetadataPoolSql(options))
    }
  }
}
