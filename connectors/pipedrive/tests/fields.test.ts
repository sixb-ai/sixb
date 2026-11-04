import { afterEach, describe, expect, test } from "bun:test"
import { PipedriveApiError, pipedrive } from "../src"
import { CONTEXT, json, mockFetch } from "./helpers"

interface RecordedCall {
  readonly method: string
  readonly path: string
  readonly contentType: string | null
  readonly body: unknown
}

function recordCalls(respond: () => Response = () => json({ success: true, data: [] })) {
  const calls: RecordedCall[] = []
  mockFetch((request, init) => {
    const url = new URL(String(request))
    calls.push({
      method: init?.method ?? "",
      path: `${url.pathname}${url.search}`,
      contentType: new Headers(init?.headers).get("content-type"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return Promise.resolve(respond())
  })
  return calls
}

describe("pipedrive fields", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test.each([
    "personFields",
    "organizationFields",
    "dealFields",
    "productFields",
  ] as const)("%s field and option calls hit exact v2 paths, methods and bodies", async (resource) => {
    const calls = recordCalls()
    const client = await pipedrive({ apiToken: "pd-token" }).connect(CONTEXT)
    const fields = client[resource]

    await fields.create({
      field_name: "Tier",
      field_type: "enum",
      options: [{ label: "Gold" }],
    })
    await fields.update("abc", { field_name: "Level" })
    await fields.delete("abc")
    await fields.addOptions("abc", [{ label: "Silver" }])
    await fields.updateOptions("abc", [{ id: 3, label: "Bronze" }])
    await fields.deleteOptions("abc", [{ id: 3 }, { id: 4 }])

    const jsonType = "application/json"
    const path = `/api/v2/${resource}`
    expect(calls).toEqual([
      {
        method: "POST",
        path,
        contentType: jsonType,
        body: { field_name: "Tier", field_type: "enum", options: [{ label: "Gold" }] },
      },
      {
        method: "PATCH",
        path: `${path}/abc`,
        contentType: jsonType,
        body: { field_name: "Level" },
      },
      { method: "DELETE", path: `${path}/abc`, contentType: null, body: undefined },
      {
        method: "POST",
        path: `${path}/abc/options`,
        contentType: jsonType,
        body: [{ label: "Silver" }],
      },
      {
        method: "PATCH",
        path: `${path}/abc/options`,
        contentType: jsonType,
        body: [{ id: 3, label: "Bronze" }],
      },
      {
        method: "DELETE",
        path: `${path}/abc/options`,
        contentType: jsonType,
        body: [{ id: 3 }, { id: 4 }],
      },
    ])
  })

  test("the built-in label field goes through the same option calls", async () => {
    const calls = recordCalls(() =>
      json({ success: true, data: [{ id: 37, label: "Broker" }], additional_data: null })
    )
    const client = await pipedrive({ apiToken: "pd-token" }).connect(CONTEXT)

    const added = await client.personFields.addOptions("label_ids", [{ label: "Broker" }])

    expect(added.data).toEqual([{ id: 37, label: "Broker" }])
    expect(calls[0]?.path).toBe("/api/v2/personFields/label_ids/options")
  })

  test("get and list pass include_fields as one comma-separated parameter", async () => {
    const calls = recordCalls()
    const client = await pipedrive({ apiToken: "pd-token" }).connect(CONTEXT)

    await client.personFields.get("label_ids", {
      include_fields: ["ui_visibility", "required_fields"],
    })
    await client.activityFields.list({ include_fields: ["ui_visibility"], limit: 500 })

    expect(
      calls.map((call) => new URL(call.path, "https://x.test").searchParams.get("include_fields"))
    ).toEqual(["ui_visibility,required_fields", "ui_visibility"])
  })

  test("activityFields offers reads only", async () => {
    recordCalls()
    const client = await pipedrive({ apiToken: "pd-token" }).connect(CONTEXT)

    // @ts-expect-error Pipedrive has no activity field writes, so the type must not offer them.
    const addOptions = client.activityFields.addOptions

    expect(addOptions).toBeUndefined()
    expect(Object.keys(client.activityFields).sort()).toEqual(["get", "list", "listAll"])
  })

  test("option calls reject an empty list without sending a request", async () => {
    const calls = recordCalls()
    const client = await pipedrive({ apiToken: "pd-token" }).connect(CONTEXT)

    for (const call of [
      () => client.personFields.addOptions("label_ids", []),
      () => client.personFields.updateOptions("label_ids", []),
      () => client.personFields.deleteOptions("label_ids", []),
    ]) {
      expect(call).toThrow("[SixbPipedrive] options must contain at least one item.")
    }

    // Proves the assertion above could fail: the same client does reach fetch.
    await client.personFields.addOptions("label_ids", [{ label: "Broker" }])
    expect(calls).toHaveLength(1)
  })

  test("a failed option call surfaces Pipedrive's error", async () => {
    recordCalls(() =>
      json(
        { success: false, error: "Field not found", code: "ERR_FIELD_NOT_FOUND" },
        { status: 404 }
      )
    )
    const client = await pipedrive({ apiToken: "pd-token" }).connect(CONTEXT)

    const error = await client.personFields
      .deleteOptions("missing", [{ id: 1 }])
      .catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(PipedriveApiError)
    expect((error as PipedriveApiError).status).toBe(404)
    expect((error as PipedriveApiError).message).toContain("Field not found")
  })
})
