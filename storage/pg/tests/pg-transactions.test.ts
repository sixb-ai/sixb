import { describe, expect, test } from "bun:test"
import type { PgStoreClient } from "../src/transactions"
import { runPgRepeatableReadTransaction, runPgTransaction } from "../src/transactions"

interface FakePool {
  readonly sql: PgStoreClient
  /** Statements sent on the reserved connection, in order. */
  readonly statements: string[]
  readonly released: () => boolean
}

/**
 * A minimal stand-in for porsager's pool: `reserve()` hands out one connection that records the
 * statements `runPgTransaction` sends itself. This is the CI-runnable check of the emitted
 * transaction statements; the Docker-gated e2e runs them against PostgreSQL.
 */
function fakePool(options: { readonly commitTag?: string } = {}): FakePool {
  const statements: string[] = []
  let released = false
  const connection = {
    unsafe: async (statement: string) => {
      statements.push(statement)
      const command = statement === "COMMIT" ? (options.commitTag ?? "COMMIT") : statement
      return Object.assign([], { command })
    },
    release: () => {
      released = true
    },
    // porsager's reserved connection exposes the pool's own `reserve`, so it must not be mistaken
    // for a pool that can start a transaction.
    reserve: async () => connection,
  }
  const sql = { reserve: async () => connection }
  return { sql: sql as unknown as PgStoreClient, statements, released: () => released }
}

function pgError(code: string, fields: Record<string, string> = {}): Error {
  return Object.assign(new Error(`sqlstate ${code}`), { code, ...fields })
}

describe("runPgTransaction", () => {
  test("folds serializable isolation into BEGIN and commits", async () => {
    const pool = fakePool()

    const result = await runPgTransaction(pool.sql, async () => "ok", {
      isolation: "serializable",
    })

    expect(result).toBe("ok")
    expect(pool.statements).toEqual(["BEGIN ISOLATION LEVEL SERIALIZABLE", "COMMIT"])
    expect(pool.released()).toBe(true)
  })

  test("omits the transaction mode when no isolation is requested", async () => {
    const pool = fakePool()

    await runPgTransaction(pool.sql, async () => "ok")

    expect(pool.statements).toEqual(["BEGIN", "COMMIT"])
  })

  test("rolls back and releases the connection when the callback throws", async () => {
    const pool = fakePool()
    const failure = pgError("23505")

    await expect(
      runPgTransaction(pool.sql, async () => {
        throw failure
      })
    ).rejects.toBe(failure)

    expect(pool.statements).toEqual(["BEGIN", "ROLLBACK"])
    expect(pool.released()).toBe(true)
  })

  test.each([
    ["porsager CONNECTION_CLOSED", pgError("CONNECTION_CLOSED")],
    ["socket ECONNRESET", pgError("ECONNRESET")],
    ["FATAL server error (pg_terminate_backend)", pgError("57P01", { severity: "FATAL" })],
  ])("sends nothing more and keeps a lost connection out of the pool: %s", async (_, lost) => {
    const pool = fakePool()

    await expect(
      runPgTransaction(pool.sql, async () => {
        throw lost
      })
    ).rejects.toBe(lost)

    expect(pool.statements).toEqual(["BEGIN"])
    expect(pool.released()).toBe(false)
  })

  test("fails when PostgreSQL answers COMMIT with a rollback", async () => {
    const pool = fakePool({ commitTag: "ROLLBACK" })

    await expect(runPgTransaction(pool.sql, async () => "ok")).rejects.toThrow(
      "rolled the transaction back instead of committing it"
    )
    expect(pool.released()).toBe(true)
  })

  test("names the full lock table behind SQLSTATE 53200", async () => {
    const exhausted = pgError("53200", {
      message: "out of shared memory",
      hint: 'You might need to increase "max_pred_locks_per_transaction".',
    })

    const error = await runPgTransaction(fakePool().sql, async () => {
      throw exhausted
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("[SixbPg]")
    expect((error as Error).message).toContain("predicate lock table is full")
    expect((error as Error).message).toContain(
      "max_pred_locks_per_transaction × (max_connections + max_prepared_transactions)"
    )
    expect((error as Error).cause).toBe(exhausted)
  })

  test("leaves a 53200 that is not about a lock table unchanged", async () => {
    const outOfMemory = pgError("53200", { message: "out of memory" })

    await expect(
      runPgTransaction(fakePool().sql, async () => {
        throw outOfMemory
      })
    ).rejects.toBe(outOfMemory)
  })

  test("runs a nested call inside the open transaction", async () => {
    const pool = fakePool()

    await runPgTransaction(pool.sql, async (tx) => {
      await runPgTransaction(tx, async () => "nested", { isolation: "serializable" })
    })

    expect(pool.statements).toEqual(["BEGIN", "COMMIT"])
  })
})

describe("runPgRepeatableReadTransaction", () => {
  test("opens selected reads at repeatable-read isolation", async () => {
    const pool = fakePool()

    const result = await runPgRepeatableReadTransaction(pool.sql, async () => "ok")

    expect(result).toBe("ok")
    expect(pool.statements).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ", "COMMIT"])
  })

  test("reuses only provider-owned repeatable-read or serializable transactions", async () => {
    for (const isolation of ["repeatableRead", "serializable"] as const) {
      const pool = fakePool()
      await runPgTransaction(
        pool.sql,
        async (tx) => {
          expect(await runPgRepeatableReadTransaction(tx, async () => isolation)).toBe(isolation)
        },
        { isolation }
      )
      expect(pool.statements).toHaveLength(2)
    }
  })

  test("rejects unverified, read-committed, and escaped transaction clients", async () => {
    await expect(
      runPgRepeatableReadTransaction({} as PgStoreClient, async () => "unverified")
    ).rejects.toThrow('{ isolation: "serializable" }')

    await runPgTransaction(fakePool().sql, async (tx) => {
      await expect(runPgRepeatableReadTransaction(tx, async () => "unsafe")).rejects.toThrow(
        "cannot join an unverified PostgreSQL transaction"
      )
    })

    let escapedClient: PgStoreClient | undefined
    await runPgTransaction(
      fakePool().sql,
      async (tx) => {
        escapedClient = tx
      },
      { isolation: "serializable" }
    )
    if (!escapedClient) throw new Error("expected a transaction client")
    await expect(
      runPgRepeatableReadTransaction(escapedClient, async () => "escaped")
    ).rejects.toThrow("cannot join an unverified PostgreSQL transaction")
  })
})
