import { describe, expect, test } from "bun:test"
import type { DuckDBValue } from "@duckdb/node-api"
import type { DuckLakeStorageOptions } from "../src"
import type { DuckDbAppender, DuckDbRuntime } from "../src/internal/duckdb-runtime"
import { DuckLakeConnectionManager } from "../src/internal/ducklake-connection-manager"

describe("DuckLakeConnectionManager", () => {
  test("does not run shared-runtime readers between PostgreSQL DETACH and ATTACH", async () => {
    const runtime = new PausedRefreshRuntime()
    const connections = new TestConnectionManager(runtime)

    try {
      const sharedRuntime = await connections.runtime()
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

const postgresOptions: DuckLakeStorageOptions = {
  catalog: {
    type: "postgres",
    host: "127.0.0.1",
    database: "postgres",
  },
  dataPath: "/tmp/pario-ducklake-test-data",
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

class TestConnectionManager extends DuckLakeConnectionManager {
  private created = false

  constructor(private readonly testRuntime: DuckDbRuntime) {
    super(postgresOptions)
  }

  override async createRuntime(): Promise<DuckDbRuntime> {
    if (this.created) {
      throw new Error("test expected a single shared runtime")
    }

    this.created = true
    return this.testRuntime
  }
}

class PausedRefreshRuntime implements DuckDbRuntime {
  private readonly detachedDeferred = createDeferred<void>()
  private readonly resumeDetachDeferred = createDeferred<void>()
  private operations: Promise<void> = Promise.resolve()
  private closed = false
  private aliasAttached = true
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

  private async runStatement(sql: string): Promise<void> {
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

  private assertAliasAttached(): void {
    if (!this.aliasAttached) {
      throw new Error("DuckLake alias is detached")
    }
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
