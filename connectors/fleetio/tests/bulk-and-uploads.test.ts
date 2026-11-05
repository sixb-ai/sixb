import { afterEach, describe, expect, test } from "bun:test"
import { FleetioApiError } from "../src"
import { createTestClient, json, recorder, route } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("bulk jobs", () => {
  test("create posts the job and get polls it", async () => {
    const calls = recorder([
      json({ id: 5, state: "pending", started_at: null, total_count: 1 }, { status: 201 }),
      json({ id: 5, state: "complete", started_at: "2026-11-05", total_count: 1, failed_count: 0 }),
    ])
    const fl = await createTestClient()
    const records = [{ vehicle_id: 1, date: "2026-11-05", value: 10000 }]

    const job = await fl.bulkJobs.create({ resource: "meter_entry", operation: "create", records })
    const finished = await fl.bulkJobs.get(job.id)

    expect(calls.map(route)).toEqual(["POST /api/bulk_api_jobs", "GET /api/bulk_api_jobs/5"])
    expect(calls[0]?.body).toEqual({ resource: "meter_entry", operation: "create", records })
    expect(finished.state).toBe("complete")
  })

  test.each([
    ["meter_entry", "create", 101, "1 to 100"],
    ["inventory_journal_entry", "create", 501, "1 to 500"],
    ["group", "update", 1001, "1 to 1000"],
    ["vehicle", "create", 0, "1 to 100"],
  ])("rejects a %s job of the wrong size before any request", async (resource, operation, count, message) => {
    const calls = recorder([])
    const fl = await createTestClient()
    const input = { resource, operation, records: Array.from({ length: count }, () => ({})) }

    expect(() => fl.bulkJobs.create(input as never)).toThrow(message)
    expect(calls).toHaveLength(0)
  })

  test("accepts the largest job a resource allows", async () => {
    const calls = recorder([json({ id: 1, state: "pending" }, { status: 201 })])
    const fl = await createTestClient()
    const records = Array.from({ length: 1000 }, () => ({
      identifier_field_name: "id",
      identifier_field_value: 1,
    }))

    await fl.bulkJobs.create({ resource: "group", operation: "update", records })

    expect(calls).toHaveLength(1)
  })
})

describe("uploads", () => {
  const POLICY = { policy: "p", signature: "s", path: "/api/ABC/" }
  const UPLOADED = { url: "https://cdn.example/x", filename: "a.png", type: "image/png", size: 3 }

  test("sends the file to the file host with the policy and without credentials", async () => {
    const calls = recorder([json(POLICY), json(UPLOADED)])
    const fl = await createTestClient()

    const uploaded = await fl.uploads.upload(new File(["abc"], "a.png", { type: "image/png" }))

    expect(calls[0]?.method).toBe("POST")
    expect(calls[0]?.url.href).toBe("https://secure.fleetio.com/api/uploads/policies")
    expect(calls[0]?.headers.get("authorization")).toBe("Token key")

    const host = calls[1]
    expect(host?.url.hostname).toBe("lmuavc3zg4.execute-api.us-east-1.amazonaws.com")
    expect(host?.url.searchParams.get("policy")).toBe("p")
    expect(host?.url.searchParams.get("signature")).toBe("s")
    expect(host?.url.searchParams.get("path")).toBe("/api/ABC/")
    expect(host?.url.searchParams.get("filename")).toBe("a.png")
    expect(host?.headers.get("content-type")).toBe("image/png")
    // Sending the upload through the REST client fails these, and would leak the account's key.
    expect(host?.headers.has("authorization")).toBe(false)
    expect(host?.headers.has("account-token")).toBe(false)
    expect(uploaded.url).toBe("https://cdn.example/x")
  })

  test("honors a filename and type for a bare Blob", async () => {
    const calls = recorder([json(POLICY), json(UPLOADED)])
    const fl = await createTestClient()

    await fl.uploads.upload(new Blob(["abc"]), {
      filename: "b.pdf",
      contentType: "application/pdf",
    })

    expect(calls[1]?.url.searchParams.get("filename")).toBe("b.pdf")
    expect(calls[1]?.headers.get("content-type")).toBe("application/pdf")
  })

  test("reports a failure from the file host", async () => {
    recorder([json(POLICY), json({ error: "too large" }, { status: 413 })])
    const fl = await createTestClient()

    const error = await fl.uploads.upload(new Blob(["abc"])).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(FleetioApiError)
    expect(error).toMatchObject({ status: 413 })
  })
})

describe("users", () => {
  test("me returns the API key's user", async () => {
    const calls = recorder([json({ id: 1, email: "sam@example.com" })])
    const fl = await createTestClient()

    const me = await fl.users.me()

    expect(route(calls[0]!)).toBe("GET /api/users/me")
    expect(me.email).toBe("sam@example.com")
  })
})
