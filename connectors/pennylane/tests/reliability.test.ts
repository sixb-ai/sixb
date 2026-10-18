import { afterEach, describe, expect, test } from "bun:test"
import { PennylaneApiError, pennylane } from "../src"
import { CONTEXT, collect, createTestClient, json, mockFetch } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("pennylane reliability", () => {
  test("does not retry write requests by default", async () => {
    let calls = 0
    mockFetch(() => {
      calls += 1
      return Promise.resolve(json({ error: "temporary" }, { status: 503 }))
    })

    const client = await createTestClient({ retry: { maxRetries: 2, delayMs: () => 0 } })
    const writes = [
      () =>
        client.quotes.create({
          date: "2026-07-10",
          deadline: "2026-08-10",
          customer_id: 7,
          invoice_lines: [],
        }),
      () => client.quotes.updateStatus(42, { status: "accepted" }),
      // Pennylane can create related records along with a ledger account.
      () => client.ledgerAccounts.create({ number: "401100", label: "Supplier account" }),
    ]
    for (const write of writes) {
      await expect(write()).rejects.toBeInstanceOf(PennylaneApiError)
    }
    expect(calls).toBe(writes.length)
  })

  test.each([
    {
      failure: "inconsistent pagination metadata",
      page: { items: [{ id: 1 }], has_more: true, next_cursor: null },
      cursor: undefined,
      error: "has_more=true but next_cursor is missing",
    },
    {
      failure: "a repeated cursor",
      page: { items: [{ id: 1 }], has_more: true, next_cursor: "same" },
      cursor: "same",
      error: "repeated next_cursor",
    },
  ])("listAll fails instead of looping on $failure", async ({ page, cursor, error }) => {
    mockFetch(() => Promise.resolve(json(page)))

    const client = await createTestClient()
    await expect(collect(client.quotes.listAll({ cursor }))).rejects.toThrow(error)
  })

  test("retries transient GET responses with a freshly resolved access token", async () => {
    const authorizations: (string | null)[] = []
    let tokenNumber = 0
    mockFetch((_input, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization"))
      return Promise.resolve(
        authorizations.length === 1
          ? json({ error: "temporary" }, { status: 503 })
          : json({ items: [], has_more: false, next_cursor: null })
      )
    })

    const client = await createTestClient({
      accessToken: () => `token-${++tokenNumber}`,
      retry: { maxRetries: 1, delayMs: () => 0 },
    })
    await client.quotes.list()

    expect(authorizations).toEqual(["Bearer token-1", "Bearer token-2"])
  })

  test("paces concurrently initiated requests", async () => {
    const startedAt: number[] = []
    mockFetch(() => {
      startedAt.push(Date.now())
      return Promise.resolve(json({ items: [], has_more: false, next_cursor: null }))
    })

    const client = await createTestClient({ minDelayMs: 10 })
    await Promise.all([client.quotes.list(), client.quotes.list(), client.quotes.list()])

    expect(startedAt).toHaveLength(3)
    expect((startedAt[1] ?? 0) - (startedAt[0] ?? 0)).toBeGreaterThanOrEqual(8)
    expect((startedAt[2] ?? 0) - (startedAt[1] ?? 0)).toBeGreaterThanOrEqual(8)
  })

  test("rejects invalid token resolvers and retry settings", async () => {
    expect(() => pennylane({ accessToken: " " })).toThrow("accessToken must not be empty")

    const adapter = pennylane({ accessToken: "token", retry: { maxRetries: -1 } })
    await expect(adapter.connect(CONTEXT)).rejects.toThrow("non-negative integer")

    const invalidDelay = pennylane({ accessToken: "token", minDelayMs: -1 })
    await expect(invalidDelay.connect(CONTEXT)).rejects.toThrow("non-negative finite number")
  })
})
