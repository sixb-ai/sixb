import { describe, expect, test } from "bun:test"
import type { DuckDBValue } from "@duckdb/node-api"
import type { DuckLakeStorageOptions } from "../src"
import type {
  DuckDbAppender,
  DuckDbExclusiveRuntime,
  DuckDbRuntime,
} from "../src/internal/duckdb-runtime"
import { DuckLakeConnectionManager } from "../src/internal/ducklake-connection-manager"

describe("DuckLakeConnectionManager", () => {
  test("starts the shared runtime unattached and attaches only once", async () => {
    const runtime = new RecordingRuntime()
    const connections = new TestConnectionManager(() => runtime)

    try {
      expect(await connections.runtime()).toBe(runtime)
      expect(runtime.attachCount()).toBe(0)

      expect(await connections.attachedRuntime()).toBe(runtime)
      expect(await connections.attachedRuntime()).toBe(runtime)
      expect(runtime.attachCount()).toBe(1)
    } finally {
      await connections.close()
    }

    expect(runtime.detachCount()).toBe(1)
    expect(runtime.closed).toBe(true)
  })

  test("does not detach an unattached runtime on close", async () => {
    const runtime = new RecordingRuntime()
    const connections = new TestConnectionManager(() => runtime)

    await connections.runtime()
    await connections.close()

    expect(runtime.attachCount()).toBe(0)
    expect(runtime.detachCount()).toBe(0)
    expect(runtime.closed).toBe(true)
  })

  test("clears failed attachments so the next request can retry with a fresh runtime", async () => {
    const first = new RecordingRuntime({ failOnAttach: true })
    const second = new RecordingRuntime()
    const runtimes = [first, second]
    const connections = new TestConnectionManager(() => {
      const runtime = runtimes.shift()
      if (!runtime) {
        throw new Error("test did not expect another runtime")
      }
      return runtime
    })

    try {
      await expect(connections.attachedRuntime()).rejects.toThrow("attach failed")
      expect(first.attachCount()).toBe(1)
      expect(first.closed).toBe(true)

      await expect(connections.attachedRuntime()).resolves.toBe(second)
      expect(second.attachCount()).toBe(1)
    } finally {
      await connections.close()
    }
  })

  test("recycles a poisoned runtime on release so leaked session state cannot reach a later lease", async () => {
    const first = new RecordingRuntime()
    const second = new RecordingRuntime()
    const runtimes = [first, second]
    const connections = new TestConnectionManager(() => {
      const runtime = runtimes.shift()
      if (!runtime) {
        throw new Error("test did not expect another runtime")
      }
      return runtime
    })

    try {
      const lease = await connections.acquireAttachedRuntime()
      expect(lease.runtime).toBe(first)

      // A guarded commit that could not RESET a session pragma poisons the
      // runtime. Release must then drop the connection instead of detaching and
      // reusing it, so the leftover setting cannot affect a later commit.
      connections.poisonRuntime()
      await lease.release()
      expect(first.closed).toBe(true)

      const next = await connections.acquireAttachedRuntime()
      expect(next.runtime).toBe(second)
      expect(second.closed).toBe(false)
      await next.release()
    } finally {
      await connections.close()
    }
  })

  test("does not run readers between DuckLake DETACH and ATTACH during reset", async () => {
    const runtime = new PausedRefreshRuntime()
    const connections = new TestConnectionManager(() => runtime)

    try {
      const sharedRuntime = await connections.attachedRuntime()
      const refresh = connections.resetRuntime()

      await withTimeout(runtime.detached(), "refresh did not reach DETACH")
      const read = sharedRuntime.query("SELECT 1 AS value")
      const readResult = read.then(
        (rows) => ({ kind: "resolved" as const, rows }),
        (error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
          kind: "rejected" as const,
        })
      )

      expect(await resolvesWithin(readResult, 25)).toBe(false)
      runtime.resumeDetach()

      await withTimeout(refresh, "refresh did not finish")
      expect(await readResult).toEqual({
        kind: "resolved",
        rows: [{ value: 1 }],
      })
    } finally {
      runtime.resumeDetach()
      await connections.close()
    }
  })
})

const localOptions: DuckLakeStorageOptions = {
  catalog: {
    type: "duckdb",
    path: ":memory:",
  },
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: Timer | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 1_000)
      }),
    ])
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }
}

async function resolvesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timeout: Timer | undefined
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true
      ),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), milliseconds)
      }),
    ])
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }
}

class TestConnectionManager extends DuckLakeConnectionManager {
  constructor(private readonly createTestRuntime: () => DuckDbRuntime) {
    super(localOptions)
  }

  override async createRuntime(): Promise<DuckDbRuntime> {
    return this.createTestRuntime()
  }
}

class RecordingRuntime implements DuckDbRuntime {
  readonly statements: string[] = []
  closed = false

  constructor(private readonly options: { readonly failOnAttach?: boolean } = {}) {}

  attachCount(): number {
    return this.statements.filter((sql) => sql.startsWith("ATTACH ")).length
  }

  detachCount(): number {
    return this.statements.filter((sql) => sql.startsWith("DETACH ")).length
  }

  run(sql: string, values?: readonly DuckDBValue[]): Promise<void> {
    void values
    this.assertOpen()
    this.statements.push(sql)
    if (this.options.failOnAttach && sql.startsWith("ATTACH ")) {
      throw new Error("attach failed")
    }
    return Promise.resolve()
  }

  async runStatements(statements: readonly string[]): Promise<void> {
    for (const sql of statements) {
      await this.run(sql)
    }
  }

  query(sql: string, values?: readonly DuckDBValue[]): Promise<readonly Record<string, unknown>[]> {
    void sql
    void values
    this.assertOpen()
    return Promise.resolve([{ value: 1 }])
  }

  async *streamRows(
    sql: string,
    values?: readonly DuckDBValue[]
  ): AsyncIterable<Record<string, unknown>> {
    void sql
    void values
    this.assertOpen()
    yield* []
  }

  withAppender<T>(
    tableName: string,
    useAppender: (appender: DuckDbAppender) => T | Promise<T>
  ): Promise<T> {
    void tableName
    void useAppender
    throw new Error("withAppender is not needed in this test")
  }

  async withExclusive<T>(useRuntime: (runtime: DuckDbExclusiveRuntime) => Promise<T>): Promise<T> {
    return useRuntime(new RecordingExclusiveRuntime(this))
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }

  assertOpen(): void {
    if (this.closed) {
      throw new Error("runtime is closed")
    }
  }
}

class RecordingExclusiveRuntime implements DuckDbExclusiveRuntime {
  constructor(private readonly runtime: RecordingRuntime) {}

  run(sql: string, values?: readonly DuckDBValue[]): Promise<void> {
    return this.runtime.run(sql, values)
  }

  runStatements(statements: readonly string[]): Promise<void> {
    return this.runtime.runStatements(statements)
  }

  query(sql: string, values?: readonly DuckDBValue[]): Promise<readonly Record<string, unknown>[]> {
    return this.runtime.query(sql, values)
  }

  withAppender<T>(
    tableName: string,
    useAppender: (appender: DuckDbAppender) => T | Promise<T>
  ): Promise<T> {
    return this.runtime.withAppender(tableName, useAppender)
  }
}

class PausedRefreshRuntime implements DuckDbRuntime {
  private readonly detachedDeferred = createDeferred<void>()
  private readonly resumeDetachDeferred = createDeferred<void>()
  private operations: Promise<void> = Promise.resolve()
  private closed = false
  private aliasAttached = false
  private detachResumed = false

  detached(): Promise<void> {
    return this.detachedDeferred.promise
  }

  resumeDetach(): void {
    if (this.detachResumed) {
      return
    }

    this.detachResumed = true
    this.resumeDetachDeferred.resolve()
  }

  run(sql: string, values?: readonly DuckDBValue[]): Promise<void> {
    void values
    return this.enqueue(() => this.runStatement(sql))
  }

  runStatements(statements: readonly string[]): Promise<void> {
    return this.enqueue(async () => {
      for (const sql of statements) {
        await this.runStatement(sql)
      }
    })
  }

  async runStatement(sql: string): Promise<void> {
    if (sql.startsWith("DETACH ")) {
      this.aliasAttached = false
      this.detachedDeferred.resolve()
      await this.resumeDetachDeferred.promise
      return
    }

    if (sql.startsWith("ATTACH ")) {
      this.aliasAttached = true
    }
  }

  query(sql: string, values?: readonly DuckDBValue[]): Promise<readonly Record<string, unknown>[]> {
    void sql
    void values
    return this.enqueue(async () => {
      this.assertAliasAttached()
      return [{ value: 1 }]
    })
  }

  async *streamRows(
    sql: string,
    values?: readonly DuckDBValue[]
  ): AsyncIterable<Record<string, unknown>> {
    void sql
    void values
    for (const row of await this.query("SELECT 1 AS value")) {
      yield row
    }
  }

  withAppender<T>(
    tableName: string,
    useAppender: (appender: DuckDbAppender) => T | Promise<T>
  ): Promise<T> {
    void tableName
    void useAppender
    throw new Error("withAppender is not needed in this test")
  }

  withExclusive<T>(useRuntime: (runtime: DuckDbExclusiveRuntime) => Promise<T>): Promise<T> {
    return this.enqueue(() => useRuntime(new PausedRefreshExclusiveRuntime(this)))
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }

    this.resumeDetach()
    await this.operations.catch(() => {})
    this.closed = true
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closed) {
      throw new Error("runtime is closed")
    }

    const result = this.operations.then(async () => {
      if (this.closed) {
        throw new Error("runtime is closed")
      }

      return operation()
    })
    this.operations = result.then(
      () => {},
      () => {}
    )
    return result
  }

  assertAliasAttached(): void {
    if (!this.aliasAttached) {
      throw new Error("DuckLake alias is detached")
    }
  }
}

class PausedRefreshExclusiveRuntime implements DuckDbExclusiveRuntime {
  constructor(private readonly runtime: PausedRefreshRuntime) {}

  run(sql: string, values?: readonly DuckDBValue[]): Promise<void> {
    void values
    return this.runtime.runStatement(sql)
  }

  async runStatements(statements: readonly string[]): Promise<void> {
    for (const sql of statements) {
      await this.runtime.runStatement(sql)
    }
  }

  query(sql: string, values?: readonly DuckDBValue[]): Promise<readonly Record<string, unknown>[]> {
    void sql
    void values
    this.runtime.assertAliasAttached()
    return Promise.resolve([{ value: 1 }])
  }

  withAppender<T>(
    tableName: string,
    useAppender: (appender: DuckDbAppender) => T | Promise<T>
  ): Promise<T> {
    void tableName
    void useAppender
    throw new Error("withAppender is not needed in this test")
  }
}

function createDeferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })

  return {
    promise,
    resolve: resolve!,
  }
}
