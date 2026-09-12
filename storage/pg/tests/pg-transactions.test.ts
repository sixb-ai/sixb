import { describe, expect, test } from "bun:test"
import type { PgStoreClient } from "../src/transactions"
import { runPgRepeatableReadTransaction, runPgTransaction } from "../src/transactions"

/**
 * A minimal stand-in for porsager's pool that records how `begin` was invoked. `runPgTransaction`
 * only uses `begin`, so a structural fake is enough to assert the emitted transaction mode without a
 * live database — this is the CI-runnable check that the `serializable` path actually reaches the
 * driver (the full provider path is exercised by the Docker-gated e2e).
 */
function fakeSql(): { sql: PgStoreClient; client: PgStoreClient; beginCalls: unknown[][] } {
  const beginCalls: unknown[][] = []
  const client = {} as PgStoreClient
  const sql = {
    begin: (...args: unknown[]) => {
      beginCalls.push(args)
      const run = args[args.length - 1] as (client: unknown) => Promise<unknown>
      return run(client)
    },
  }
  return { sql: sql as unknown as PgStoreClient, client, beginCalls }
}

describe("runPgTransaction isolation", () => {
  test("folds serializable isolation into BEGIN", async () => {
    const { sql, beginCalls } = fakeSql()

    const result = await runPgTransaction(sql, async () => "ok", { isolation: "serializable" })

    expect(result).toBe("ok")
    expect(beginCalls).toHaveLength(1)
    expect(beginCalls[0]?.[0]).toBe("isolation level serializable")
    expect(typeof beginCalls[0]?.[1]).toBe("function")
  })

  test("omits the transaction mode when no isolation is requested", async () => {
    const { sql, beginCalls } = fakeSql()

    await runPgTransaction(sql, async () => "ok")

    expect(beginCalls).toHaveLength(1)
    expect(beginCalls[0]).toHaveLength(1)
    expect(typeof beginCalls[0]?.[0]).toBe("function")
  })

  test("opens selected reads at repeatable-read isolation", async () => {
    const { sql, beginCalls } = fakeSql()

    const result = await runPgRepeatableReadTransaction(sql, async () => "ok")

    expect(result).toBe("ok")
    expect(beginCalls).toHaveLength(1)
    expect(beginCalls[0]?.[0]).toBe("isolation level repeatable read")
  })

  test("reuses only provider-owned repeatable-read or serializable transactions", async () => {
    const repeatable = fakeSql()
    const serializable = fakeSql()

    await runPgTransaction(
      repeatable.sql,
      async (tx) => {
        expect(await runPgRepeatableReadTransaction(tx, async () => "repeatable")).toBe(
          "repeatable"
        )
      },
      { isolation: "repeatableRead" }
    )
    await runPgTransaction(
      serializable.sql,
      async (tx) => {
        expect(await runPgRepeatableReadTransaction(tx, async () => "serializable")).toBe(
          "serializable"
        )
      },
      { isolation: "serializable" }
    )
  })

  test("rejects unverified, read-committed, and escaped transaction clients", async () => {
    await expect(
      runPgRepeatableReadTransaction({} as PgStoreClient, async () => "unverified")
    ).rejects.toThrow('{ isolation: "serializable" }')

    const readCommitted = fakeSql()
    await runPgTransaction(readCommitted.sql, async (tx) => {
      await expect(runPgRepeatableReadTransaction(tx, async () => "unsafe")).rejects.toThrow(
        "cannot join an unverified PostgreSQL transaction"
      )
    })

    const escaped = fakeSql()
    let escapedClient: PgStoreClient | undefined
    await runPgTransaction(
      escaped.sql,
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
