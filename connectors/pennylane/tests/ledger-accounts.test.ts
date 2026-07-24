import { afterEach, describe, expect, test } from "bun:test"
import { PennylaneApiError } from "../src"
import { collect, createTestClient, json, mockFetch } from "./helpers"

const originalFetch = globalThis.fetch

const LEDGER_ACCOUNT = {
  id: 42,
  number: "706100",
  label: "Consulting services",
  vat_rate: "FR_200",
  country_alpha2: "FR",
  enabled: true,
  type: "custom",
  letterable: false,
  created_at: "2026-07-01T10:00:00.000Z",
  updated_at: "2026-07-20T15:30:00.000Z",
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("pennylane ledger accounts", () => {
  test("lists ledger accounts with every documented filter family", async () => {
    let requestUrl = ""
    let requestHeaders = new Headers()
    mockFetch((input, init) => {
      requestUrl = String(input)
      requestHeaders = new Headers(init?.headers)
      return Promise.resolve(json({ items: [LEDGER_ACCOUNT], has_more: null, next_cursor: null }))
    })

    const client = await createTestClient()
    const page = await client.ledgerAccounts.list({
      cursor: "opaque+cursor==",
      limit: 1000,
      sort: "-id",
      filter: [
        { field: "id", operator: "gteq", value: 40 },
        { field: "id", operator: "not_in", value: [43, "44"] },
        { field: "number", operator: "start_with", value: "706" },
        { field: "number", operator: "eq", value: "706100" },
        { field: "number", operator: "in", value: ["706100", "706200"] },
        { field: "enabled", operator: "eq", value: true },
      ],
    })

    const url = new URL(requestUrl)
    expect(url.pathname).toBe("/api/external/v2/ledger_accounts")
    expect(url.searchParams.get("cursor")).toBe("opaque+cursor==")
    expect(url.searchParams.get("limit")).toBe("1000")
    expect(url.searchParams.get("sort")).toBe("-id")
    expect(JSON.parse(url.searchParams.get("filter") ?? "")).toEqual([
      { field: "id", operator: "gteq", value: 40 },
      { field: "id", operator: "not_in", value: [43, "44"] },
      { field: "number", operator: "start_with", value: "706" },
      { field: "number", operator: "eq", value: "706100" },
      { field: "number", operator: "in", value: ["706100", "706200"] },
      { field: "enabled", operator: "eq", value: true },
    ])
    expect(requestHeaders.get("authorization")).toBe("Bearer pl-token")
    expect(page.items[0]).toEqual(LEDGER_ACCOUNT)
    expect(page.has_more).toBeNull()
  })

  test("listAll preserves query state and treats nullable has_more as terminal", async () => {
    const requests: Array<{
      cursor: string | null
      limit: string | null
      sort: string | null
      filter: unknown
    }> = []
    mockFetch((input) => {
      const url = new URL(String(input))
      const filter = url.searchParams.get("filter")
      requests.push({
        cursor: url.searchParams.get("cursor"),
        limit: url.searchParams.get("limit"),
        sort: url.searchParams.get("sort"),
        filter: filter ? JSON.parse(filter) : null,
      })

      return Promise.resolve(
        json(
          requests.length === 1
            ? { items: [{ ...LEDGER_ACCOUNT, id: 1 }], has_more: true, next_cursor: "next" }
            : { items: [{ ...LEDGER_ACCOUNT, id: 2 }], has_more: null, next_cursor: null }
        )
      )
    })

    const client = await createTestClient()
    const accounts = await collect(
      client.ledgerAccounts.listAll({
        limit: 2,
        sort: "id",
        filter: [{ field: "enabled", operator: "eq", value: true }],
      })
    )

    expect(accounts.map((account) => account.id)).toEqual([1, 2])
    expect(requests).toEqual([
      {
        cursor: null,
        limit: "2",
        sort: "id",
        filter: [{ field: "enabled", operator: "eq", value: true }],
      },
      {
        cursor: "next",
        limit: "2",
        sort: "id",
        filter: [{ field: "enabled", operator: "eq", value: true }],
      },
    ])
  })

  test("sends the documented get, create, and update requests", async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = []
    mockFetch((input, init) => {
      requests.push({
        path: new URL(String(input)).pathname,
        method: init?.method ?? "",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return Promise.resolve(json(LEDGER_ACCOUNT, { status: init?.method === "POST" ? 201 : 200 }))
    })

    const client = await createTestClient()
    expect(await client.ledgerAccounts.get(42)).toEqual(LEDGER_ACCOUNT)
    expect(
      await client.ledgerAccounts.create({
        number: "706100",
        label: "Consulting services",
        vat_rate: "FR_200",
        country_alpha2: "FR",
      })
    ).toEqual(LEDGER_ACCOUNT)
    expect(
      await client.ledgerAccounts.update(42, {
        label: "Professional services",
        letterable: true,
      })
    ).toEqual(LEDGER_ACCOUNT)

    expect(requests).toEqual([
      { path: "/api/external/v2/ledger_accounts/42", method: "GET", body: undefined },
      {
        path: "/api/external/v2/ledger_accounts",
        method: "POST",
        body: {
          number: "706100",
          label: "Consulting services",
          vat_rate: "FR_200",
          country_alpha2: "FR",
        },
      },
      {
        path: "/api/external/v2/ledger_accounts/42",
        method: "PUT",
        body: { label: "Professional services", letterable: true },
      },
    ])
  })

  test("validates ids, cursors, limits, and account numbers before fetch", async () => {
    let calls = 0
    mockFetch(() => {
      calls += 1
      return Promise.resolve(json({ items: [], has_more: false, next_cursor: null }))
    })

    const client = await createTestClient()
    expect(() => client.ledgerAccounts.get(0)).toThrow("positive safe integer")
    expect(() => client.ledgerAccounts.update(Number.MAX_SAFE_INTEGER + 1, {})).toThrow(
      "positive safe integer"
    )
    expect(() => client.ledgerAccounts.list({ cursor: " " })).toThrow("cursor must not be empty")
    expect(() => client.ledgerAccounts.list({ limit: 1001 })).toThrow("between 1 and 1000")
    expect(() =>
      client.ledgerAccounts.create({ number: "706 100", label: "Invalid account" })
    ).toThrow("non-empty string without whitespace")
    expect(calls).toBe(0)
  })

  test("does not retry create because Pennylane can create related records", async () => {
    let calls = 0
    mockFetch(() => {
      calls += 1
      return Promise.resolve(json({ error: "temporary" }, { status: 503 }))
    })

    const client = await createTestClient({ retry: { maxRetries: 2, delayMs: () => 0 } })
    await expect(
      client.ledgerAccounts.create({ number: "401100", label: "Supplier account" })
    ).rejects.toBeInstanceOf(PennylaneApiError)
    expect(calls).toBe(1)
  })
})
