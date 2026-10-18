import { afterEach, describe, expect, test } from "bun:test"
import { microsoft } from "../src"
import { connect, GRAPH, json, mockFetch, restoreFetch } from "./helpers"

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

  // Delivery URL, lifetime and missing-secret checks are shared with contacts.subscribe and
  // subscriptions.create, whose tests cover them.
  test("validates the webhook secret configuration and change types", async () => {
    expect(() => microsoft({ auth: { token: () => "token" }, onEvent() {} })).toThrow(
      "webhookSecret"
    )
    expect(() =>
      microsoft({ auth: { token: () => "token" }, webhookSecret: "x".repeat(129) })
    ).toThrow("128")
    const requests = mockFetch(() => json({ id: "s" }))
    const { mail } = await connect({ webhookSecret: "secret" })
    await expect(mail.subscribe("u", { ...options(), changeTypes: [] })).rejects.toThrow(
      "changeTypes"
    )
    expect(requests).toHaveLength(0)
  })
})
