import { afterEach, describe, expect, test } from "bun:test"
import { LinkedinApiError } from "../src"
import { collect, createTestClient, empty, json, mockFetch, recorder } from "./helpers"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("linkedin reliability", () => {
  test("retries transient GET responses with a fresh token", async () => {
    const authorizations: (string | null)[] = []
    let tokenNumber = 0
    mockFetch((_input, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization"))
      return Promise.resolve(
        authorizations.length === 1
          ? json({ message: "temporary" }, { status: 503 })
          : json({ id: 1, name: "Acme", type: "BUSINESS" })
      )
    })
    const client = await createTestClient({
      accessToken: () => `token-${++tokenNumber}`,
      retry: { maxRetries: 1, delayMs: () => 0 },
    })

    await client.adAccounts.get(1)
    expect(authorizations).toEqual(["Bearer token-1", "Bearer token-2"])
  })

  test("does not retry writes by default", async () => {
    const calls = recorder([json({ message: "temporary" }, { status: 503 })])
    const client = await createTestClient({ retry: { maxRetries: 2, delayMs: () => 0 } })

    await expect(
      client.adAccounts.create({ name: "Acme", type: "BUSINESS" })
    ).rejects.toBeInstanceOf(LinkedinApiError)
    expect(calls).toHaveLength(1)
  })

  test("preserves structured API errors and response metadata", async () => {
    recorder([
      json(
        { message: "Missing required field", serviceErrorCode: 100, status: 400 },
        { status: 400, headers: { "x-li-uuid": "request-123" } }
      ),
    ])
    const client = await createTestClient()

    try {
      await client.adAccounts.get(1)
      throw new Error("expected request to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(LinkedinApiError)
      const apiError = error as LinkedinApiError
      expect(apiError.status).toBe(400)
      expect(apiError.serviceErrorCode).toBe(100)
      expect(apiError.requestId).toBe("request-123")
      expect(apiError.responseBody).toEqual({
        message: "Missing required field",
        serviceErrorCode: 100,
        status: 400,
      })
    }
  })

  test("fails on repeated cursor tokens", async () => {
    recorder([
      json({
        elements: [{ id: 1, name: "A", type: "BUSINESS" }],
        metadata: { nextPageToken: "same" },
      }),
      json({
        elements: [{ id: 2, name: "B", type: "BUSINESS" }],
        metadata: { nextPageToken: "same" },
      }),
    ])
    const client = await createTestClient()

    await expect(
      collect(client.adAccounts.searchAll({ statuses: ["ACTIVE"], pageToken: "initial" }))
    ).rejects.toThrow("repeated nextPageToken")
  })

  test("rejects missing creation identifiers", async () => {
    recorder([empty(201)])
    const client = await createTestClient()
    await expect(client.adAccounts.create({ name: "Acme", type: "BUSINESS" })).rejects.toThrow(
      "missing the x-restli-id"
    )
  })
})
