import { afterEach, describe, expect, test } from "bun:test"
import type { PennylaneLedgerAccountListOptions } from "../src"
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
  test("listAll follows opaque cursors with every filter family and stops on null has_more", async () => {
    const requests: URL[] = []
    mockFetch((input) => {
      const url = new URL(String(input))
      requests.push(url)
      return Promise.resolve(
        json(
          requests.length === 1
            ? {
                items: [{ ...LEDGER_ACCOUNT, id: 1 }],
                has_more: true,
                next_cursor: "opaque+cursor==",
              }
            : { items: [{ ...LEDGER_ACCOUNT, id: 2 }], has_more: null, next_cursor: null }
        )
      )
    })

    const filter: NonNullable<PennylaneLedgerAccountListOptions["filter"]> = [
      { field: "id", operator: "gteq", value: 40 },
      { field: "id", operator: "not_in", value: [43, "44"] },
      { field: "number", operator: "start_with", value: "706" },
      { field: "number", operator: "eq", value: "706100" },
      { field: "number", operator: "in", value: ["706100", "706200"] },
      { field: "enabled", operator: "eq", value: true },
    ]
    const client = await createTestClient()
    const accounts = await collect(
      client.ledgerAccounts.listAll({ limit: 1000, sort: "-id", filter })
    )

    expect(accounts).toEqual([
      { ...LEDGER_ACCOUNT, id: 1 },
      { ...LEDGER_ACCOUNT, id: 2 },
    ])
    expect(requests.map((url) => url.searchParams.get("cursor"))).toEqual([null, "opaque+cursor=="])
    for (const url of requests) {
      expect(url.pathname).toBe("/api/external/v2/ledger_accounts")
      expect(url.searchParams.get("limit")).toBe("1000")
      expect(url.searchParams.get("sort")).toBe("-id")
      expect(JSON.parse(url.searchParams.get("filter") ?? "")).toEqual(filter)
    }
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
})
