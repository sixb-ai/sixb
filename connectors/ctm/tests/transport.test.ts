import { afterEach, describe, expect, test } from "bun:test"
import { CtmApiError, CtmConfigurationError, ctm } from "../src"
import {
  ACCOUNT_ID,
  CONTEXT,
  callPage,
  createTestClient,
  empty,
  json,
  mockFetch,
  page,
  recorder,
  route,
} from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("requests", () => {
  test("authenticate with basic auth from the access and secret keys, under api/v1", async () => {
    const calls = recorder([callPage([])])
    const client = await createTestClient()

    await client.calls.list()

    expect(calls[0]?.url.origin).toBe("https://api.calltrackingmetrics.com")
    expect(route(calls[0]!)).toBe(`GET /api/v1/accounts/${ACCOUNT_ID}/calls`)
    expect(calls[0]?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("key:secret").toString("base64")}`
    )
    expect(calls[0]?.headers.get("accept")).toBe("application/json")
  })

  test("resolve credentials on each request and honor baseUrl", async () => {
    const calls = recorder([page("users", []), page("users", [])])
    let rotation = 0
    const client = await createTestClient({
      secretKey: async () => `secret-${++rotation}`,
      baseUrl: "https://example.test/api/v1",
    })

    await client.users.list()
    await client.users.list()

    expect(calls[1]?.url.href).toStartWith("https://example.test/api/v1/accounts/12345/users")
    expect(calls[1]?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("key:secret-2").toString("base64")}`
    )
  })

  test("reject empty credentials and account IDs before any request", () => {
    expect(() => ctm({ accessKey: " ", secretKey: "secret" })).toThrow(CtmConfigurationError)
    expect(() => ctm({ accessKey: "key", secretKey: "" })).toThrow("secretKey")
    expect(() => ctm({ accessKey: "key", secretKey: "secret", accountId: Number.NaN })).toThrow(
      CtmConfigurationError
    )
  })

  test("do not retry a resolver that returns nothing", async () => {
    const calls = recorder([])
    const client = await createTestClient({ accessKey: () => "" })

    const error = await client.calls.list().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CtmConfigurationError)
    expect(calls).toHaveLength(0)
  })

  test("reject invalid paging before any request", async () => {
    const calls = recorder([])
    const client = await createTestClient()

    const zero = await client.users.list({ pageSize: 0 }).catch((caught: unknown) => caught)
    const fraction = await client.calls.list({ pageSize: 1.5 }).catch((caught: unknown) => caught)

    expect(String(zero)).toContain("pageSize must be a positive integer")
    expect(String(fraction)).toContain("pageSize must be a positive integer")
    expect(calls).toHaveLength(0)
  })

  test("encode a path segment and reject an empty one", async () => {
    const calls = recorder([json({ id: "USR1" })])
    const client = await createTestClient()

    await client.users.get("USR/1")

    expect(calls[0]?.url.pathname).toBe(`/api/v1/accounts/${ACCOUNT_ID}/users/USR%2F1`)

    const error = await client.users.get(" ").catch((caught: unknown) => caught)
    expect(String(error)).toContain("userId must not be empty")
  })
})

describe("accounts", () => {
  test("account resources fail without an account, naming both ways to give one", async () => {
    const calls = recorder([page("accounts", [{ id: 1, name: "Acme" }])])
    const client = await ctm({ accessKey: "key", secretKey: "secret" }).connect(CONTEXT)

    const error = await client.calls.list().catch((caught: unknown) => caught)
    const accounts = await client.accounts.list()

    expect(error).toBeInstanceOf(CtmConfigurationError)
    expect(String(error)).toContain("client.account(id)")
    expect(accounts.records.map((account) => account.name)).toEqual(["Acme"])
    expect(route(calls[0]!)).toBe("GET /api/v1/accounts?page=1")
  })

  test("account(id) addresses another account with the same resources", async () => {
    const calls = recorder([callPage([])])
    const client = await createTestClient()

    await client.account(777).calls.list()

    expect(route(calls[0]!)).toBe("GET /api/v1/accounts/777/calls")
    expect(() => client.account(-1)).toThrow(CtmConfigurationError)
  })

  test("list names, status and the agency", async () => {
    const calls = recorder([
      json({ accounts: [{ id: 1, name: "Acme" }] }),
      json({ id: 1, name: "Acme", status: "success", account_status: "active" }),
      json({ agency: { id: 2, name: "Agency" } }),
    ])
    const client = await createTestClient()

    expect(await client.accounts.listNames()).toEqual([{ id: 1, name: "Acme" }])
    expect((await client.accounts.status(1)).account_status).toBe("active")
    expect(await client.agency.get()).toEqual({ id: 2, name: "Agency" })
    expect(calls.map(route)).toEqual([
      "GET /api/v1/accounts.json?names=1&all=1",
      "GET /api/v1/accounts/1/status",
      "GET /api/v1/agency",
    ])
  })
})

describe("error bodies", () => {
  test.each([
    ["an error field", () => json({ error: "Invalid key" }, { status: 401 }), "401: Invalid key"],
    ["a message field", () => json({ message: "Not found" }, { status: 404 }), "404: Not found"],
    ["an errors array", () => json({ errors: ["a", "b"] }, { status: 422 }), "422: a; b"],
    ["field errors", () => json({ errors: { name: ["blank"] } }, { status: 422 }), "name: blank"],
    ["a plain string", () => new Response("Forbidden", { status: 403 }), "403: Forbidden"],
    ["an empty body", () => empty(403), "failed with 403."],
  ])("surface %s", async (_name, response, message) => {
    mockFetch(async () => response())
    const client = await createTestClient({ retry: { maxRetries: 0 } })

    const error = await client.calls.get(1).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CtmApiError)
    expect(String(error)).toContain(message)
  })

  test("keep the body and parse Retry-After", async () => {
    mockFetch(async () => json({ error: "slow" }, { status: 429, headers: { "retry-after": "3" } }))
    const client = await createTestClient({ retry: { maxRetries: 0 } })

    const error = await client.calls.get(1).catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      status: 429,
      responseBody: { error: "slow" },
      retryAfterMs: 3000,
    })
  })
})

describe("retries", () => {
  const rateLimited = () =>
    json({ error: "slow" }, { status: 429, headers: { "retry-after": "0" } })

  test.each([
    ["a 429", rateLimited],
    ["a 500", () => json({ error: "oops" }, { status: 500, headers: { "retry-after": "0" } })],
  ])("a read retries %s", async (_name, failure) => {
    const calls = recorder([failure(), callPage([])])
    const client = await createTestClient()

    await client.calls.list()

    expect(calls).toHaveLength(2)
  })

  test("the call search is a read, so it retries like one", async () => {
    const calls = recorder([rateLimited(), callPage([])])
    const client = await createTestClient()

    await client.calls.search()

    expect(calls).toHaveLength(2)
  })

  test("a write retries a 429, which means the request was refused", async () => {
    const calls = recorder([rateLimited(), json({ status: "success" })])
    const client = await createTestClient()

    await client.calls.markSpam(1)

    expect(calls).toHaveLength(2)
  })

  test("a write does not retry a 500, which may have been processed", async () => {
    const calls = recorder([json({ error: "oops" }, { status: 500 })])
    const client = await createTestClient()

    const error = await client.calls.markSpam(1).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CtmApiError)
    expect(calls).toHaveLength(1)
  })

  test("stops at maxRetries and reports the last response", async () => {
    const calls = recorder(() => rateLimited())
    const client = await createTestClient({ retry: { maxRetries: 1 } })

    const error = await client.calls.list().catch((caught: unknown) => caught)

    expect(error).toMatchObject({ status: 429 })
    expect(calls).toHaveLength(2)
  })

  test("a custom policy replaces the default and sees the request's safety", async () => {
    const seen: boolean[] = []
    const calls = recorder([rateLimited()])
    const client = await createTestClient({
      retry: {
        shouldRetry(context) {
          seen.push(context.idempotent)
          return false
        },
      },
    })

    await client.calls.list().catch(() => undefined)

    expect(calls).toHaveLength(1)
    expect(seen).toEqual([true])
  })

  test("rejects invalid reliability options when connecting", async () => {
    const retries = await Promise.resolve(
      ctm({ accessKey: "key", secretKey: "secret", retry: { maxRetries: -1 } }).connect(CONTEXT)
    ).catch((caught: unknown) => caught)
    const delay = await Promise.resolve(
      ctm({ accessKey: "key", secretKey: "secret", minDelayMs: -1 }).connect(CONTEXT)
    ).catch((caught: unknown) => caught)

    expect(String(retries)).toContain("retry.maxRetries")
    expect(String(delay)).toContain("minDelayMs")
  })
})
