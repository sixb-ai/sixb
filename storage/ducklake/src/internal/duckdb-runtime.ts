import {
  type DuckDBConnection,
  DuckDBInstance,
  type DuckDBValue,
  type DuckDBAppender as NodeDuckDBAppender,
} from "@duckdb/node-api"
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
  runStatements(statements: readonly string[]): Promise<void>
  query(sql: string, values?: readonly DuckDBValue[]): Promise<readonly Record<string, unknown>[]>
  streamRows(sql: string, values?: readonly DuckDBValue[]): AsyncIterable<Record<string, unknown>>
  withAppender<T>(
    tableName: string,
    useAppender: (appender: DuckDbAppender) => T | Promise<T>
  ): Promise<T>
  close(): Promise<void>
}

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
      return reader.getRowObjectsJS()
    })
  }

  async *streamRows(
    sql: string,
    values?: readonly DuckDBValue[]
  ): AsyncIterable<Record<string, unknown>> {
    this.assertAcceptingOperations()

    let releaseOperation: (() => void) | undefined
    const operationFinished = new Promise<void>((resolve) => {
      releaseOperation = resolve
    })
    const waitForTurn = this.operations.then(() => {
      this.assertNotClosed()
    })
    this.operations = waitForTurn
      .then(() => operationFinished)
      .then(
        () => {},
        () => {}
      )

    try {
      await waitForTurn
      const result = await this.connection.stream(
        sql,
        values === undefined ? undefined : [...values]
      )
      for await (const batch of result.yieldRowObjectJs()) {
        for (const row of batch) {
          yield row as Record<string, unknown>
        }
      }
    } finally {
      releaseOperation?.()
    }
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
      throw new LakeStorageError("[ParioDuckLake] DuckDB runtime is closed.")
    }
  }

  private assertNotClosed(): void {
    if (this.closed) {
      throw new LakeStorageError("[ParioDuckLake] DuckDB runtime is closed.")
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
  const instance = await DuckDBInstance.create(options.path ?? ":memory:", options.config ?? {})
  return new NodeDuckDbRuntime(instance, await instance.connect())
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
 * Load DuckLake, load catalog extensions, run caller setup SQL, and attach the
 * configured DuckLake catalog.
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

  for (const secret of options.secrets ?? []) {
    await runtime.run(buildCreateSecretSql(secret))
  }

  await runtime.run(buildAttachSql(options))

  if (options.catalog.type === "postgres") {
    await runtime.run(buildConfigurePostgresMetadataPoolSql(options))
  }
}
