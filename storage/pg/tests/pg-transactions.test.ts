import { describe, expect, test } from "bun:test"
import type { PgStoreClient } from "../src/transactions"
import { runPgTransaction } from "../src/transactions"

/**
 * A minimal stand-in for porsager's pool that records how `begin` was invoked. `runPgTransaction`
 * only uses `begin`, so a structural fake is enough to assert the emitted transaction mode without a
 * live database — this is the CI-runnable check that the `serializable` path actually reaches the
 * driver (the full provider path is exercised by the Docker-gated e2e).
 */
function fakeSql(): { sql: PgStoreClient; beginCalls: unknown[][] } {
  const beginCalls: unknown[][] = []
  const sql = {
    begin: (...args: unknown[]) => {
      beginCalls.push(args)
      const run = args[args.length - 1] as (client: unknown) => Promise<unknown>
      return run({})
    },
  }
  return { sql: sql as unknown as PgStoreClient, beginCalls }
}

describe("runPgTransaction isolation", () => {
  test("folds repeatable-read isolation into BEGIN", async () => {
    const { sql, beginCalls } = fakeSql()

    const result = await runPgTransaction(sql, async () => "ok", {
      isolation: "repeatable-read",
    })

    expect(result).toBe("ok")
    expect(beginCalls).toHaveLength(1)
    expect(beginCalls[0]?.[0]).toBe("isolation level repeatable read")
    expect(typeof beginCalls[0]?.[1]).toBe("function")
  })

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
})
