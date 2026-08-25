import { describe, expect, test } from "bun:test"
import { runBoundedConnectorProviderOperation } from "../src/connectors/connections/provider-operation"

describe("connector provider operation boundary", () => {
  test("never enters the adapter when the host is already aborted", async () => {
    const host = new AbortController()
    const interruption = new Error("host stopped")
    host.abort(interruption)
    let calls = 0

    await expect(
      runBoundedConnectorProviderOperation(
        { hostSignal: host.signal, timeoutMs: 1_000 },
        () => {
          calls += 1
        },
        () => interruption
      )
    ).rejects.toBe(interruption)
    expect(calls).toBe(0)
  })
})
