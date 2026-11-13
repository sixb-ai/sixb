import { afterEach, describe, expect, test } from "bun:test"
import type { MicrosoftSubscription } from "../src"
import { connect, GRAPH, json, mockFetch, type RecordedRequest, restoreFetch } from "./helpers"

afterEach(restoreFetch)

const DAY = 86_400_000
const URL = "https://app.example/api/webhooks/microsoft/events"
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString()
const MAILBOX = { changeTypes: ["created", "updated"] as const, notificationUrl: URL }

/** Graph's subscriptions collection, kept in memory; `on` replaces one call's answer. */
function graph(
  initial: readonly MicrosoftSubscription[] = [],
  on: Partial<Record<"POST" | "PATCH", (request: RecordedRequest) => Response | undefined>> = {}
) {
  const subscriptions = new Map(initial.map((subscription) => [subscription.id, subscription]))
  let created = 0
  const requests = mockFetch((request) => {
    const id = decodeURIComponent(request.url.slice(`${GRAPH}subscriptions/`.length))
    const body = request.init.body ? JSON.parse(String(request.init.body)) : undefined
    switch (request.method) {
      case "GET":
        return json({ value: [...subscriptions.values()] })
      case "POST": {
        // Stored before answering: a lost or conflicting answer still leaves it in Graph.
        const subscription = { id: `created-${++created}`, ...body }
        subscriptions.set(subscription.id, subscription)
        return on.POST?.(request) ?? json(subscription, 201)
      }
      case "PATCH": {
        const answer = on.PATCH?.(request)
        if (answer) return answer
        const current = subscriptions.get(id)
        if (!current) return json({ error: { code: "ResourceNotFound" } }, 404)
        const renewed = { ...current, ...body }
        subscriptions.set(id, renewed)
        return json(renewed)
      }
      case "DELETE":
        subscriptions.delete(id)
        return new Response(null, { status: 204 })
      default:
        return json({}, 405)
    }
  })
  const calls = () =>
    requests.map(({ method, url }) => `${method} ${url.slice(GRAPH.length).replace(/\?.*/, "")}`)
  return { subscriptions, requests, calls }
}

const inbox = (id: string, expiresInDays: number, resource = "users/ops%40contoso.com/messages") =>
  ({ id, resource, notificationUrl: URL, expirationDateTime: inDays(expiresInDays) }) as const

describe("ensuring a subscription", () => {
  test("keeps one with more than three days left, untouched", async () => {
    const fake = graph([inbox("current", 5)])
    const { mail } = await connect({ webhookSecret: "secret" })

    const result = await mail.ensureSubscription("ops@contoso.com", MAILBOX)
    expect(result).toMatchObject({ action: "kept", subscription: { id: "current" } })
    expect(fake.calls()).toEqual(["GET subscriptions"])
  })

  test("renews one closer to expiring, to six days out", async () => {
    const fake = graph([inbox("current", 1)])
    const { mail } = await connect({ webhookSecret: "secret" })

    const result = await mail.ensureSubscription("ops@contoso.com", MAILBOX)
    expect(result.action).toBe("renewed")
    expect(fake.calls()).toEqual(["GET subscriptions", "PATCH subscriptions/current"])
    const expiry = Date.parse(fake.subscriptions.get("current")?.expirationDateTime ?? "")
    expect(Math.abs(expiry - (Date.now() + 6 * DAY))).toBeLessThan(60_000)
  })

  // Countercheck: rethrow every error from update in ensureSubscription; this run fails.
  test("creates one when there is none, or when the one listed is gone by the time it renews", async () => {
    // Same mailbox, another app's receiver: not this subscription.
    const empty = graph([
      { ...inbox("other-url", 5), notificationUrl: "https://elsewhere.example/hook" },
    ])
    const { mail } = await connect({ webhookSecret: "secret" })
    expect((await mail.ensureSubscription("ops@contoso.com", MAILBOX)).action).toBe("created")
    expect(empty.calls()).toEqual(["GET subscriptions", "POST subscriptions"])
    const body = JSON.parse(String(empty.requests[1]?.init.body))
    expect(body).toMatchObject({
      resource: "users/ops%40contoso.com/messages",
      changeType: "created,updated",
      clientState: "secret",
      lifecycleNotificationUrl: URL,
    })
    expect(empty.requests[1]?.headers.get("prefer")).toBe('IdType="ImmutableId"')
    expect(empty.subscriptions.has("other-url")).toBe(true)

    const vanished = graph([inbox("current", 1)], {
      PATCH: () => json({ error: { code: "ResourceNotFound" } }, 404),
    })
    expect((await mail.ensureSubscription("ops@contoso.com", MAILBOX)).action).toBe("created")
    expect(vanished.calls()).toEqual([
      "GET subscriptions",
      "PATCH subscriptions/current",
      "POST subscriptions",
    ])
  })

  // Countercheck: rethrow every error from create in ensureSubscription; both runs fail.
  test("adopts the match when creating returns 409 or an unknown outcome", async () => {
    const { mail } = await connect({ webhookSecret: "secret" })
    for (const answer of [
      () => json({ error: { code: "Conflict" } }, 409),
      () => {
        throw new TypeError("socket hang up")
      },
    ]) {
      const fake = graph([], { POST: answer })
      const result = await mail.ensureSubscription("ops@contoso.com", MAILBOX)
      expect(result).toMatchObject({ action: "adopted", subscription: { id: "created-1" } })
      expect(fake.calls()).toEqual(["GET subscriptions", "POST subscriptions", "GET subscriptions"])
    }
  })

  test("keeps the longest-lasting duplicate and deletes the rest, however Graph spells the resource", async () => {
    const fake = graph([
      inbox("short", 1),
      inbox("long", 5, "/Users/ops@contoso.com/Messages"),
      inbox("middle", 2, "users/OPS@contoso.com/messages"),
    ])
    const { mail } = await connect({ webhookSecret: "secret" })

    const result = await mail.ensureSubscription("ops@contoso.com", MAILBOX)
    expect(result).toMatchObject({ action: "kept", subscription: { id: "long" } })
    expect(fake.calls()).toEqual([
      "GET subscriptions",
      "DELETE subscriptions/middle",
      "DELETE subscriptions/short",
    ])
  })

  test("works for any resource, with the connector's clientState", async () => {
    const fake = graph()
    const { subscriptions } = await connect({ webhookSecret: "secret" })

    await subscriptions.ensure({
      resource: "users/user-id/events",
      changeType: "created,updated,deleted",
      notificationUrl: URL,
    })
    expect(JSON.parse(String(fake.requests[1]?.init.body))).toMatchObject({
      resource: "users/user-id/events",
      clientState: "secret",
    })
  })

  test("rejects lifetimes it can't keep before sending anything", async () => {
    const fake = graph()
    const { mail, subscriptions } = await connect({ webhookSecret: "secret" })
    const input = {
      resource: "drives/d/root",
      changeType: "updated" as const,
      notificationUrl: URL,
    }

    for (const [run, message] of [
      [() => subscriptions.ensure(input, { renewWithinMs: 6 * DAY }), "renewWithinMs"],
      [() => subscriptions.ensure(input, { lifetimeMs: 0 }), "lifetimeMs"],
      [() => mail.ensureSubscription("u", { ...MAILBOX, lifetimeMs: 8 * DAY }), "seven days"],
    ] as const)
      expect(await run().catch((error) => error)).toHaveProperty(
        "message",
        expect.stringContaining(message)
      )
    expect(
      await (await connect()).mail.ensureSubscription("u", MAILBOX).catch((error) => error)
    ).toHaveProperty("message", expect.stringContaining("webhookSecret is required"))
    expect(fake.requests).toHaveLength(0)
  })
})
