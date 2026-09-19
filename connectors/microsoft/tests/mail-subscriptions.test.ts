import { afterEach, describe, expect, test } from "bun:test"
import { MicrosoftConfigurationError, microsoft } from "../src"
import { apiError, collect, connect, GRAPH, json, mockFetch, restoreFetch } from "./helpers"

afterEach(restoreFetch)
const expires = () => new Date(Date.now() + 3 * 86_400_000).toISOString()
const options = () => ({
  changeTypes: ["created", "updated", "deleted"] as const,
  notificationUrl: "https://app.example/api/webhooks/microsoft/events",
  expirationDateTime: expires(),
})

describe("mail subscriptions", () => {
  test("creates mailbox and folder subscriptions with immutable IDs and matching clientState", async () => {
    const requests = mockFetch(() => json({ id: "s" }, 201))
    const { mail } = await connect({ webhookSecret: "secret" })
    expect((await mail.subscribe("ops@contoso.com", options())).id).toBe("s")
    await mail.subscribe("ops@contoso.com", {
      ...options(),
      folderId: "folder/id",
      lifecycleNotificationUrl: "https://app.example/lifecycle",
    })
    const bodies = requests.map((r) => JSON.parse(String(r.init.body)))
    expect(bodies[0]).toMatchObject({
      resource: "users/ops%40contoso.com/messages",
      changeType: "created,updated,deleted",
      clientState: "secret",
      includeResourceData: false,
    })
    expect(bodies[0].lifecycleNotificationUrl).toBe(bodies[0].notificationUrl)
    expect(bodies[1].resource).toBe("users/ops%40contoso.com/mailFolders/folder%2Fid/messages")
    expect(bodies[1].lifecycleNotificationUrl).toBe("https://app.example/lifecycle")
    expect(requests[0].url).toBe(`${GRAPH}subscriptions`)
    expect(requests[0].headers.get("prefer")).toBe('IdType="ImmutableId"')
  })

  test("lists, gets, renews, reauthorizes and deletes subscriptions", async () => {
    const next = `${GRAPH}subscriptions?$skiptoken=next`
    const responses = [
      json({ value: [{ id: "s" }], "@odata.nextLink": next }),
      json({ value: [{ id: "s2" }] }),
      json({ id: "s" }),
      json({ id: "s" }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
    ]
    const requests = mockFetch(() => responses.shift()!)
    const client = await connect()
    expect((await collect(client.subscriptions.listAll())).map((s) => s.id)).toEqual(["s", "s2"])
    await client.subscriptions.get("s")
    const expirationDateTime = expires()
    await client.subscriptions.renew("s", expirationDateTime)
    await client.subscriptions.reauthorize("s")
    await client.subscriptions.delete("s")
    expect(requests.map((r) => r.method)).toEqual(["GET", "GET", "GET", "PATCH", "POST", "DELETE"])
    expect(JSON.parse(String(requests[3].init.body))).toEqual({ expirationDateTime })
    expect(requests[4].url).toBe(`${GRAPH}subscriptions/s/reauthorize`)
  })

  test("validates secrets, HTTPS delivery URLs, change types and lifetime", async () => {
    expect(() => microsoft({ auth: { token: () => "token" }, onEvent() {} })).toThrow(
      "webhookSecret"
    )
    expect(() =>
      microsoft({ auth: { token: () => "token" }, webhookSecret: "x".repeat(129) })
    ).toThrow("128")
    const requests = mockFetch(() => json({ id: "s" }))
    await expect((await connect()).mail.subscribe("u", options())).rejects.toThrow("webhookSecret")
    const { mail } = await connect({ webhookSecret: "secret" })
    for (const invalid of [
      { notificationUrl: "http://app.example/webhook" },
      { expirationDateTime: "yesterday" },
      { expirationDateTime: new Date(Date.now() + 8 * 86_400_000).toISOString() },
      { changeTypes: [] },
    ])
      await expect(mail.subscribe("u", { ...options(), ...invalid })).rejects.toThrow()
    expect(requests).toHaveLength(0)
    await expect((await connect()).subscriptions.renew("s", "invalid")).rejects.toBeInstanceOf(
      MicrosoftConfigurationError
    )
  })

  test("does not replay ambiguous subscription mutations even with retries configured", async () => {
    const requests = mockFetch(() => apiError(503, "ServiceUnavailable"))
    const client = await connect({ webhookSecret: "secret", retry: { maxRetries: 3 } })
    await expect(client.mail.subscribe("u", options())).rejects.toMatchObject({
      status: 503,
    })
    await expect(client.subscriptions.renew("s", expires())).rejects.toMatchObject({ status: 503 })
    expect(requests).toHaveLength(2)
  })
})
