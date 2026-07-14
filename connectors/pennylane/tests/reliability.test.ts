import { afterEach, describe, expect, test } from "bun:test"
import { PennylaneApiError, pennylane } from "../src"
import { CONTEXT, collect, createTestClient, json, mockFetch } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("pennylane reliability", () => {
  test("retries transient GET responses", async () => {
    let calls = 0
    mockFetch(() => {
      calls += 1
      const count = calls
      if (count === 1) {
        return Promise.resolve(json({ error: "temporary" }, { status: 503 }))
      }
      return Promise.resolve(json({ items: [], has_more: false, next_cursor: null }))
    })

    const client = await createTestClient({ retry: { maxRetries: 1, delayMs: () => 0 } })
    await client.quotes.list()

    expect(calls).toBe(2)
  })

  test("does not retry write requests by default", async () => {
    const methods: string[] = []
    mockFetch(() => {
      methods.push("called")
      return Promise.resolve(json({ error: "temporary" }, { status: 503 }))
    })

    const client = await createTestClient({ retry: { maxRetries: 2, delayMs: () => 0 } })
    await expect(
      client.quotes.create({
        date: "2026-07-10",
        deadline: "2026-08-10",
        customer_id: 7,
        invoice_lines: [],
      })
    ).rejects.toBeInstanceOf(PennylaneApiError)
    await expect(client.quotes.updateStatus(42, { status: "accepted" })).rejects.toBeInstanceOf(
      PennylaneApiError
    )
    expect(methods).toHaveLength(2)
  })

  test("fails instead of looping on inconsistent pagination metadata", async () => {
    mockFetch(() =>
      Promise.resolve(json({ items: [{ id: 1 }], has_more: true, next_cursor: null }))
    )

    const client = await createTestClient()
    await expect(collect(client.quotes.listAll())).rejects.toThrow(
      "has_more=true but next_cursor is missing"
    )
  })

  test("fails on repeated cursors", async () => {
    mockFetch(() =>
      Promise.resolve(json({ items: [{ id: 1 }], has_more: true, next_cursor: "same" }))
    )

    const client = await createTestClient()
    await expect(collect(client.quotes.listAll({ cursor: "same" }))).rejects.toThrow(
      "repeated next_cursor"
    )
  })

  test("resolves rotated access tokens for every attempt", async () => {
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
