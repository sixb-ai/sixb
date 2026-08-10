import { afterEach, expect, test } from "bun:test"
import {
  collect,
  createTestClient,
  DSN,
  json,
  jsonBody,
  originalFetch,
  query,
  recorder,
  TOKEN,
} from "./helpers"

afterEach(() => {
  globalThis.fetch = originalFetch
})

function account(id: string) {
  return {
    object: "Account",
    id,
    name: "LinkedIn",
    type: "LINKEDIN",
    created_at: "2026-08-10T10:00:00.000Z",
    sources: [{ id: "MESSAGING", status: "OK" }],
  }
}

test("accounts list sends DSN auth and cursor parameters", async () => {
  const calls = recorder([json({ object: "AccountList", items: [account("a1")], cursor: null })])
  const client = await createTestClient()

  const page = await client.accounts.list({ limit: 50, cursor: "next" })

  expect(page.items[0]?.id).toBe("a1")
  expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/v1/accounts")
  expect(query(calls[0]?.url ?? "").get("limit")).toBe("50")
  expect(query(calls[0]?.url ?? "").get("cursor")).toBe("next")
  expect(calls[0]?.headers.get("x-api-key")).toBe(TOKEN)
  expect(calls[0]?.headers.get("accept")).toBe("application/json")
})

test("accounts listAll follows opaque cursors and preserves the limit", async () => {
  const calls = recorder([
    json({ object: "AccountList", items: [account("a1")], cursor: "c2" }),
    json({ object: "AccountList", items: [account("a2")], cursor: null }),
  ])
  const client = await createTestClient()

  const accounts = await collect(client.accounts.listAll({ limit: 1 }))

  expect(accounts.map((item) => item.id)).toEqual(["a1", "a2"])
  expect(query(calls[0]?.url ?? "").get("limit")).toBe("1")
  expect(query(calls[1]?.url ?? "").get("limit")).toBe("1")
  expect(query(calls[1]?.url ?? "").get("cursor")).toBe("c2")
})

test("accounts listAll refuses a repeated cursor", async () => {
  recorder([
    json({ object: "AccountList", items: [account("a1")], cursor: "same" }),
    json({ object: "AccountList", items: [account("a2")], cursor: "same" }),
  ])
  const client = await createTestClient()

  await expect(collect(client.accounts.listAll())).rejects.toThrow("repeated cursor")
})

test("accounts get encodes the account id", async () => {
  const calls = recorder([json(account("account/one"))])
  const client = await createTestClient()

  await client.accounts.get("account/one")

  expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/v1/accounts/account%2Fone")
})

test("hosted auth defaults api_url to the DSN", async () => {
  const calls = recorder([json({ object: "HostedAuthURL", url: "https://account.unipile.com/x" })])
  const client = await createTestClient()

  const result = await client.hostedAuth.createLink({
    type: "create",
    providers: ["LINKEDIN"],
    expiresOn: "2099-12-22T12:00:00.701Z",
    success_redirect_url: "https://app.example/settings/integrations",
  })

  expect(result.url).toBe("https://account.unipile.com/x")
  expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/v1/hosted/accounts/link")
  expect(calls[0]?.method).toBe("POST")
  expect(jsonBody(calls[0] as NonNullable<(typeof calls)[number]>)).toEqual({
    type: "create",
    providers: ["LINKEDIN"],
    expiresOn: "2099-12-22T12:00:00.701Z",
    success_redirect_url: "https://app.example/settings/integrations",
    api_url: DSN,
  })
})

test("hosted auth validates reconnect input before sending", async () => {
  const client = await createTestClient()

  expect(() =>
    client.hostedAuth.createLink({
      type: "reconnect",
      reconnect_account: "",
      expiresOn: "2099-12-22T12:00:00.701Z",
    })
  ).toThrow("reconnect_account must not be empty")
})

test("list limits are validated before sending", async () => {
  const client = await createTestClient()

  expect(() => client.accounts.list({ limit: 251 })).toThrow("between 1 and 250")
})
