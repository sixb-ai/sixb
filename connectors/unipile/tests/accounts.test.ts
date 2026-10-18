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

test("accounts list and get send DSN auth to their documented routes", async () => {
  const calls = recorder([
    json({ object: "AccountList", items: [account("a1")], cursor: null }),
    json(account("account/one")),
  ])
  const client = await createTestClient()

  const page = await client.accounts.list({ limit: 50, cursor: "next" })
  await client.accounts.get("account/one")

  expect(page.items[0]?.id).toBe("a1")
  expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
    "/api/v1/accounts",
    "/api/v1/accounts/account%2Fone",
  ])
  expect(query(calls[0]?.url ?? "").get("limit")).toBe("50")
  expect(query(calls[0]?.url ?? "").get("cursor")).toBe("next")
  expect(calls[0]?.headers.get("x-api-key")).toBe(TOKEN)
  expect(calls[0]?.headers.get("accept")).toBe("application/json")
})

test("accounts listAll refuses a repeated cursor", async () => {
  recorder([
    json({ object: "AccountList", items: [account("a1")], cursor: "same" }),
    json({ object: "AccountList", items: [account("a2")], cursor: "same" }),
  ])
  const client = await createTestClient()

  await expect(collect(client.accounts.listAll())).rejects.toThrow("repeated cursor")
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
