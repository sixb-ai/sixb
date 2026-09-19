import { afterEach, describe, expect, test } from "bun:test"
import {
  MicrosoftApiError,
  MicrosoftConfigurationError,
  MicrosoftSubscriptionMutationError,
  type SubscriptionCreate,
  type SubscriptionUpdate,
} from "../src"
import { apiError, collect, connect, GRAPH, json, mockFetch, restoreFetch } from "./helpers"

afterEach(restoreFetch)
const input: SubscriptionCreate = {
  resource: "drives/drive-id/root",
  changeType: "updated",
  notificationUrl: "https://example.com/hooks/graph",
  expirationDateTime: "2099-01-01T00:00:00Z",
  clientState: "secret",
  lifecycleNotificationUrl: "https://example.com/hooks/lifecycle",
}

describe("Graph subscriptions", () => {
  test("creates basic subscriptions with explicit Outlook immutable IDs and existing auth", async () => {
    const requests = mockFetch(() => json({ id: "sub", ...input }, 201))
    const client = await connect()
    expect((await client.subscriptions.create(input, { immutableIds: true })).id).toBe("sub")
    expect(requests[0]?.url).toBe(`${GRAPH}subscriptions`)
    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer graph-token")
    expect(requests[0]?.headers.get("Prefer")).toBe('IdType="ImmutableId"')
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual(input)
  })

  test("preserves Graph resource paths with a leading slash and multiple change types", async () => {
    const requests = mockFetch(() => json({ id: "sub" }, 201))
    const client = await connect()
    const body = {
      ...input,
      resource: "/users/user-id/events",
      changeType: "created,updated,deleted" as const,
    }
    await client.subscriptions.create(body)
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual(body)
    expect(requests[0]?.headers.has("Prefer")).toBe(false)
  })

  test("updates only supported properties and preserves service expiration", async () => {
    const requests = mockFetch(() =>
      json({ id: "a/b", expirationDateTime: "2099-01-01T00:45:00Z" })
    )
    const client = await connect()
    expect(
      await client.subscriptions.update("a/b", { expirationDateTime: input.expirationDateTime })
    ).toEqual({ id: "a/b", expirationDateTime: "2099-01-01T00:45:00Z" })
    expect(requests[0]?.url).toBe(`${GRAPH}subscriptions/a%2Fb`)
    expect(requests[0]?.method).toBe("PATCH")
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      expirationDateTime: input.expirationDateTime,
    })
    await client.subscriptions.update("a/b", { notificationUrl: input.notificationUrl })
  })

  test("delete and reauthorize send no body and require 204", async () => {
    const requests = mockFetch(() => new Response(null, { status: 204 }))
    const client = await connect()
    await client.subscriptions.delete("sub")
    await client.subscriptions.reauthorize("sub")
    expect(requests.map((r) => [r.method, r.url, r.init.body])).toEqual([
      ["DELETE", `${GRAPH}subscriptions/sub`, undefined],
      ["POST", `${GRAPH}subscriptions/sub/reauthorize`, undefined],
    ])
  })

  test("get supports selection; list has no invented OData parameters", async () => {
    const requests = mockFetch((r) =>
      json(r.url.includes("/sub?") ? { id: "sub" } : { value: [{ id: "sub" }] })
    )
    const client = await connect()
    await client.subscriptions.get("sub", { select: ["expirationDateTime"] })
    expect(new URL(requests[0]!.url).searchParams.get("$select")).toContain("expirationDateTime")
    expect((await client.subscriptions.list()).value).toEqual([{ id: "sub" }])
    expect(requests[1]?.url).toBe(`${GRAPH}subscriptions`)
  })

  test("iterates empty pages and preserves opaque next links", async () => {
    const next = `${GRAPH}subscriptions?$skiptoken=opaque%2Btoken`
    const requests = mockFetch((r) =>
      json(r.url === next ? { value: [{ id: "sub" }] } : { value: [], "@odata.nextLink": next })
    )
    const client = await connect()
    expect(await collect(client.subscriptions.listAll())).toEqual([{ id: "sub" }])
    expect(requests[1]?.url).toBe(next)
  })

  test("rejects pagination credential exfiltration and cycles", async () => {
    const requests = mockFetch(() =>
      json({ value: [], "@odata.nextLink": "https://evil.example/subscriptions" })
    )
    const client = await connect()
    await expect(collect(client.subscriptions.listAll())).rejects.toThrow()
    expect(requests).toHaveLength(1)
    mockFetch(() => json({ value: [], "@odata.nextLink": `${GRAPH}subscriptions` }))
    await expect(collect(client.subscriptions.listAll())).rejects.toThrow("repeated")
  })

  test("rejects invalid and unsupported inputs before sending anything", async () => {
    const requests = mockFetch(() => json({ id: "sub" }, 201))
    const client = await connect()
    const badCreates = [
      { ...input, notificationUrl: "http://example.com" },
      { ...input, notificationUrl: "https://user:pass@example.com" },
      { ...input, resource: "https://graph.microsoft.com/v1.0/drives/x/root" },
      { ...input, expirationDateTime: "2099-02-30T00:00:00Z" },
      { ...input, expirationDateTime: "2000-01-01T00:00:00Z" },
      { ...input, changeType: "updated,updated" },
      { ...input, clientState: "x".repeat(129) },
      { ...input, includeResourceData: true },
      { ...input, encryptionCertificate: "certificate" },
      { ...input, id: "read-only" },
    ]
    for (const invalid of badCreates)
      expect(() => client.subscriptions.create(invalid as SubscriptionCreate)).toThrow(
        MicrosoftConfigurationError
      )
    // Countercheck: removing validateUpdate makes this test send unsupported lifecycle fields.
    for (const invalid of [
      {},
      { lifecycleNotificationUrl: input.notificationUrl },
      { clientState: "new" },
    ])
      expect(() => client.subscriptions.update("sub", invalid as SubscriptionUpdate)).toThrow(
        MicrosoftConfigurationError
      )
    expect(requests).toHaveLength(0)
  })

  test("accepts expiration shorter than 45 minutes without locally clamping it", async () => {
    const requests = mockFetch(() => json({ id: "sub" }, 201))
    const client = await connect()
    const expirationDateTime = new Date(Date.now() + 60_000).toISOString()
    await client.subscriptions.create({ ...input, expirationDateTime })
    expect(JSON.parse(String(requests[0]?.init.body)).expirationDateTime).toBe(expirationDateTime)
  })

  test.each([
    404, 409, 429, 503,
  ])("preserves HTTP %i without retrying mutations", async (status) => {
    const requests = mockFetch(() => apiError(status))
    const client = await connect({ retry: { maxRetries: 2, delayMs: () => 0 } })
    await expect(client.subscriptions.create(input)).rejects.toMatchObject({ status })
    expect(requests).toHaveLength(1)
  })

  test("renewal, deletion and reauthorization are never replayed or silently recovered", async () => {
    const requests = mockFetch(() => apiError(503))
    const client = await connect({ retry: { maxRetries: 2, delayMs: () => 0 } })
    await expect(
      client.subscriptions.update("sub", { expirationDateTime: input.expirationDateTime })
    ).rejects.toMatchObject({ status: 503 })
    await expect(client.subscriptions.delete("sub")).rejects.toMatchObject({ status: 503 })
    await expect(client.subscriptions.reauthorize("sub")).rejects.toMatchObject({ status: 503 })
    expect(requests.map((request) => request.method)).toEqual(["PATCH", "DELETE", "POST"])
    mockFetch(() => apiError(404))
    await expect(
      client.subscriptions.update("expired", { expirationDateTime: input.expirationDateTime })
    ).rejects.toMatchObject({ status: 404 })
    await expect(client.subscriptions.delete("absent")).rejects.toMatchObject({ status: 404 })
  })

  test("cancellation during a dispatched mutation preserves an uncertain outcome", async () => {
    const controller = new AbortController()
    const requests = mockFetch(
      (request) =>
        new Promise((_resolve, reject) => {
          request.init.signal?.addEventListener(
            "abort",
            () => reject(request.init.signal?.reason),
            { once: true }
          )
          controller.abort(new Error("stopped"))
        })
    )
    const client = await connect()
    await expect(
      client.subscriptions.create(input, { signal: controller.signal })
    ).rejects.toMatchObject({ outcomeUnknown: true })
    expect(requests).toHaveLength(1)
  })

  test("read operations reuse configured retries", async () => {
    let attempts = 0
    mockFetch(() => (++attempts === 1 ? apiError(503) : json({ value: [] })))
    const client = await connect({ retry: { maxRetries: 1, delayMs: () => 0 } })
    await client.subscriptions.list()
    expect(attempts).toBe(2)
  })

  test("interrupted transport and unreadable success are uncertain, never replayed", async () => {
    const client = await connect({ retry: { maxRetries: 2, delayMs: () => 0 } })
    const requests = mockFetch(() => {
      throw new TypeError("network lost")
    })
    await expect(client.subscriptions.create(input)).rejects.toBeInstanceOf(
      MicrosoftSubscriptionMutationError
    )
    expect(requests).toHaveLength(1)
    mockFetch(() => new Response("invalid json", { status: 201 }))
    await expect(client.subscriptions.create(input)).rejects.toMatchObject({ outcomeUnknown: true })
    mockFetch(() => json({ id: "sub" }, 200))
    await expect(client.subscriptions.create(input)).rejects.toMatchObject({ outcomeUnknown: true })
    mockFetch(() => apiError(409))
    await expect(client.subscriptions.create(input)).rejects.toBeInstanceOf(MicrosoftApiError)
  })

  test("already cancelled requests are not reported as uncertain", async () => {
    const requests = mockFetch(() => json({ id: "sub" }, 201))
    const client = await connect()
    const signal = AbortSignal.abort(new Error("cancelled"))
    await expect(client.subscriptions.create(input, { signal })).rejects.toThrow("cancelled")
    expect(requests).toHaveLength(0)
  })
})
