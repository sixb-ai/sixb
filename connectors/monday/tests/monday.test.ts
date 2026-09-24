import { afterEach, describe, expect, test } from "bun:test"
import {
  MondayApiError,
  type MondayColumnWrites,
  type MondayConnectorOptions,
  monday,
} from "../src"

interface Call {
  url: string
  init: RequestInit
  query: string
  variables: Record<string, unknown>
}
const originalFetch = globalThis.fetch
let calls: Call[] = []
afterEach(() => {
  globalThis.fetch = originalFetch
  calls = []
})
function mock(handler: (call: Call) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body))
    const call = { url: String(input), init, ...body } as Call
    calls.push(call)
    return handler(call)
  }) as typeof fetch
}
const response = (data: unknown) => Response.json({ data })
const item = (id = "123") => ({
  id,
  name: "Example",
  url: "https://example.monday.com/boards/1/pulses/123",
  created_at: null,
  updated_at: null,
  board: { id: "1" },
  parent_item: null,
  group: null,
  column_values: [],
})
async function client(
  options: Partial<MondayConnectorOptions> = {},
  signal = new AbortController().signal
) {
  return monday({ token: "secret", minDelayMs: 0, ...options }).connect({
    projectId: "test",
    connectorId: "monday",
    signal,
  })
}
async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of items) result.push(item)
  return result
}

describe("Monday transport", () => {
  test("connects lazily, rotates tokens, pins API version, and never interpolates values into GraphQL", async () => {
    mock(() => response({ change_simple_column_value: { id: "123", board: { id: "1" } } }))
    let token = "first"
    const api = await client({ token: () => token })
    expect(calls).toHaveLength(0)
    const name = 'quoted " name\n mutation { delete_item }'
    await api.items.rename({ board_id: "1", item_id: "123", name })
    token = "second"
    await api.items.rename({ board_id: "1", item_id: "123", name: "other" })
    expect(calls[0].url).toBe("https://api.monday.com/v2")
    expect(calls[0].query).not.toContain(name)
    expect(calls[0].variables.name).toBe(name)
    expect(calls.map((c) => new Headers(c.init.headers).get("authorization"))).toEqual([
      "first",
      "second",
    ])
    expect(new Headers(calls[0].init.headers).get("api-version")).toBe("2026-07")
    expect(calls[0].init.redirect).toBe("error")
  })

  // Guard proof: remove the errors-array check in http.ts; this test must fail.
  test("rejects HTTP 200 GraphQL errors and preserves partial writes and request metadata", async () => {
    const body = {
      data: { change_multiple_column_values: { id: "123" } },
      errors: [
        {
          message: "One field failed",
          path: ["change_multiple_column_values"],
          extensions: { code: "ColumnValueException" },
        },
      ],
      extensions: { request_id: "req-1" },
    }
    mock(() => Response.json(body, { headers: { "Retry-After": "2" } }))
    const api = await client()
    try {
      await api.items.changeColumns({
        board_id: "1",
        item_id: "123",
        column_values: { status: { label: "Approved" } },
      })
      throw new Error("Expected API error")
    } catch (error) {
      expect(error).toBeInstanceOf(MondayApiError)
      if (!(error instanceof MondayApiError)) throw error
      expect(error.partialData).toEqual(body.data)
      expect(error.requestId).toBe("req-1")
      expect(error.retryAfterMs).toBe(2000)
      expect(error.errors[0].path).toEqual(["change_multiple_column_values"])
    }
    expect(calls).toHaveLength(1)
  })

  test.each([429, 503])("retries safe GraphQL POST reads for HTTP %i", async (status) => {
    mock(() =>
      calls.length === 1
        ? Response.json({}, { status, headers: { "retry-after": "0" } })
        : response({ items: [item()] })
    )
    expect((await (await client()).items.get("123"))?.id).toBe("123")
    expect(calls).toHaveLength(2)
  })

  test("retries GraphQL complexity rejection with its body delay", async () => {
    mock(() =>
      calls.length === 1
        ? Response.json({
            errors: [
              {
                message: "Wait",
                extensions: { code: "COMPLEXITY_BUDGET_EXHAUSTED", retry_in_seconds: 0 },
              },
            ],
          })
        : response({ items: [item()] })
    )
    expect((await (await client()).items.get("123"))?.id).toBe("123")
    expect(calls).toHaveLength(2)
  })

  test("does not hide partial read errors or retry authorization/daily-limit failures", async () => {
    const api = await client()
    for (const body of [
      {
        data: { items: [item()] },
        errors: [
          { message: "Wait", extensions: { code: "ComplexityException", retry_in_seconds: 0 } },
        ],
      },
      { errors: [{ message: "Denied", extensions: { code: "UserUnauthorizedException" } }] },
      { errors: [{ message: "Daily limit", extensions: { code: "DAILY_LIMIT_EXCEEDED" } }] },
    ]) {
      mock(() => Response.json(body))
      await expect(api.items.get("123")).rejects.toBeInstanceOf(MondayApiError)
    }
    expect(calls).toHaveLength(3)
  })

  // Guard proof: retry every HTTP 429 regardless of error code; this test must fail.
  test("surfaces permanent provider failures even with HTTP 429", async () => {
    const api = await client()
    for (const body of [
      { errors: [{ message: "Daily limit", extensions: { code: "DAILY_LIMIT_EXCEEDED" } }] },
      { error_code: "DAILY_LIMIT_EXCEEDED", error_message: "Daily limit" },
      { errors: [{ message: "Denied", extensions: { code: "UserUnauthorizedException" } }] },
    ]) {
      mock(() => Response.json(body, { status: 429, headers: { "retry-after": "0" } }))
      await expect(api.items.get("123")).rejects.toBeInstanceOf(MondayApiError)
    }
    expect(calls).toHaveLength(3)
  })

  // Guard proof: mark writes idempotent/retryable in http.ts; this test must fail.
  test.each([429, 503])("never replays mutations, even for HTTP %i", async (status) => {
    mock(() => Response.json({}, { status, headers: { "retry-after": "0" } }))
    await expect(
      (await client()).items.create({ board_id: "1", item_name: "One item" })
    ).rejects.toBeInstanceOf(MondayApiError)
    expect(calls).toHaveLength(1)
  })

  test("does not replay a mutation with an ambiguous network failure", async () => {
    mock(() => {
      throw new TypeError("Connection lost")
    })
    await expect(
      (await client()).updates.create({ item_id: "123", body: "Hello" })
    ).rejects.toThrow("Connection lost")
    expect(calls).toHaveLength(1)
  })

  test("bounds retries and preserves HTTP errors", async () => {
    mock(() =>
      Response.json({ error_message: "Busy" }, { status: 503, headers: { "retry-after": "0" } })
    )
    await expect((await client({ maxRetries: 1 })).items.get("123")).rejects.toMatchObject({
      status: 503,
      body: { error_message: "Busy" },
    })
    expect(calls).toHaveLength(2)
  })

  test("request cancellation interrupts provider backoff", async () => {
    const abort = new AbortController()
    mock(() => {
      setTimeout(() => abort.abort(), 10)
      return Response.json({}, { status: 429, headers: { "retry-after": "60" } })
    })
    await expect(
      (await client()).items.get("123", {}, { signal: abort.signal })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toHaveLength(1)
  })

  test("runtime cancellation and timeout propagate without retries", async () => {
    const abort = new AbortController()
    abort.abort()
    mock(() => response({ items: [] }))
    await expect((await client({}, abort.signal)).items.get("123")).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(calls).toHaveLength(0)
    mock(
      (call) =>
        new Promise((_resolve, reject) => {
          call.init.signal?.addEventListener("abort", () => reject(call.init.signal?.reason), {
            once: true,
          })
        })
    )
    await expect((await client({ timeoutMs: 10 })).items.get("123")).rejects.toMatchObject({
      name: "TimeoutError",
    })
    expect(calls).toHaveLength(1)
  })

  test.each([
    {},
    { data: null },
    { data: {}, errors: "bad" },
    { data: { items: null } },
    { data: { items: [{}] } },
  ])("rejects malformed envelopes or entity lists %j", async (body) => {
    mock(() => Response.json(body))
    await expect((await client()).items.get("123")).rejects.toThrow("[SixbMonday]")
  })
  test("rejects invalid configuration and resolved credentials", async () => {
    for (const token of ["", " \n", "a\nb"]) expect(() => monday({ token })).toThrow("token")
    for (const endpoint of [
      "file:///tmp/x",
      "https://u:p@example.com",
      "https://example.com/?token=x",
    ])
      expect(() => monday({ token: "t", endpoint })).toThrow("endpoint")
    for (const options of [{ timeoutMs: 0 }, { minDelayMs: -1 }, { maxRetries: 1.2 }])
      expect(() => monday({ token: "t", ...options })).toThrow("[SixbMonday]")
    mock(() => response({ items: [] }))
    await expect((await client({ token: () => "" })).items.get("123")).rejects.toThrow("token")
    expect(calls).toHaveLength(0)
  })
})

describe("Monday resources", () => {
  // Guard proof: reject null in values(); the supported people-clear case must fail.
  test("supports clearing people and caller-owned idempotency keys without write retries", async () => {
    mock(() => response({ change_multiple_column_values: { id: "123", board: { id: "1" } } }))
    const api = await client()
    await api.items.changeColumns(
      { board_id: "1", item_id: "123", column_values: { person: null } },
      { idempotencyKey: "operation-1" }
    )
    expect(calls[0].variables.column_values).toBe('{"person":null}')
    expect(new Headers(calls[0].init.headers).get("idempotency-key")).toBe("operation-1")
    await expect(
      api.items.create({ board_id: "1", item_name: "x" }, { idempotencyKey: "bad\nkey" })
    ).rejects.toThrow("idempotencyKey")
    expect(calls).toHaveLength(1)
  })

  // Guard proof: stop listAll when items.length === 0 instead of cursor === null;
  // this fixture must fail because a cursor, not page length, controls traversal.
  test("paginates filtered items across an empty page, retaining column selection and opaque cursors", async () => {
    const cursor = "opaque/%+?=="
    mock((call) =>
      call.query.includes("next_items_page")
        ? response({ next_items_page: { cursor: null, items: [item("456")] } })
        : response({ boards: [{ id: "1", items_page: { cursor, items: [] } }] })
    )
    const api = await client()
    const query_params = { rules: [{ column_id: "status", compare_value: [2] }] }
    expect(
      await collect(
        api.items.listAll({ board_id: "1", limit: 7, query_params, column_ids: ["status"] })
      )
    ).toEqual([item("456")])
    expect(calls[0].variables.query_params).toEqual(query_params)
    expect(calls[1].variables).toEqual({ cursor, limit: 7, column_ids: ["status"] })
    expect(calls[1].query).not.toContain("boards(")
  })
  test("detects repeated cursors instead of looping forever", async () => {
    mock((call) =>
      response(
        call.query.includes("next_items_page")
          ? { next_items_page: { cursor: "same", items: [] } }
          : { boards: [{ id: "1", items_page: { cursor: "same", items: [] } }] }
      )
    )
    await expect(collect((await client()).items.listAll({ board_id: "1" }))).rejects.toThrow(
      "Repeated pagination cursor"
    )
    expect(calls).toHaveLength(2)
  })
  test("distinguishes missing parents from empty collections and supports missing entity lookups", async () => {
    mock(() => response({ boards: [], items: [], users: [], assets: [] }))
    const api = await client()
    expect(await api.items.get("123")).toBeNull()
    expect(await api.users.get("123")).toBeNull()
    expect(await api.assets.get("123")).toBeNull()
    await expect(api.boards.get("1")).rejects.toThrow("not found")
    await expect(api.items.list({ board_id: "1" })).rejects.toThrow("not found")
    await expect(api.subitems.list("123")).rejects.toThrow("not found")
    await expect(api.updates.list({ item_id: "123" })).rejects.toThrow("not found")
  })
  test("discovers groups, view metadata and distinct parent/subitem schemas without reading app content", async () => {
    const columns = [
      {
        id: "status",
        title: "Status",
        type: "status",
        settings: '{"labels":{"2":"Needs Review"}}',
        revision: "r",
        description: null,
      },
    ]
    mock((call) =>
      response(
        call.query.includes("items(")
          ? { items: [{ id: "123", board: { id: "2", columns } }] }
          : {
              boards: [
                {
                  id: "1",
                  columns,
                  groups: [{ id: "topics", title: "Social Media", color: "#fff" }],
                  views: [{ id: "3", name: "Content Brief", type: "FeatureBoardView" }],
                },
              ],
            }
      )
    )
    const api = await client()
    expect(await api.columns.list("1")).toEqual(columns)
    expect(await api.columns.forItem("123")).toEqual({ board_id: "2", columns })
    expect((await api.groups.list("1"))[0].id).toBe("topics")
    expect((await api.boards.views("1"))[0].name).toBe("Content Brief")
    expect(calls[3].query).not.toContain("settings")
  })
  test("reads subitems without truncation and walks deeper descendants with physical board IDs", async () => {
    const child = { ...item("456"), board: { id: "2" }, parent_item: { id: "123" } }
    const grandchild = { ...item("789"), parent_item: { id: "456" } }
    mock((call) => {
      const parent = (call.variables.ids as string[])[0]
      return response({
        items: [
          {
            id: parent,
            subitems: parent === "123" ? [child] : parent === "456" ? [grandchild] : [],
          },
        ],
      })
    })
    expect(await collect((await client()).subitems.listAll("123"))).toEqual([child, grandchild])
    expect(calls).toHaveLength(3)
    expect(calls[0].query).not.toContain("subitems(limit")
  })
  test("serializes only explicit column writes, preserves string IDs, and disables label creation", async () => {
    mock(() =>
      response({
        change_multiple_column_values: { id: "9007199254740993", board: { id: "2" } },
        create_item: { id: "123", board: { id: "1" } },
        create_subitem: { id: "456", board: { id: "2" } },
        move_item_to_group: { id: "123", board: { id: "1" } },
      })
    )
    const api = await client()
    const columns: MondayColumnWrites = {
      caption: { text: 'A "quoted" caption\nwith newline' },
      status: { label: "Approved" },
      date: { date: "2026-10-01" },
      person: { personsAndTeams: [{ id: 123, kind: "person" }] },
      link: { url: "https://example.com/a", text: "Media" },
      timeline: { from: "2026-10-01", to: "2026-10-02" },
      notes: "",
      clear_status: {},
    }
    await api.items.changeColumns({
      board_id: "2",
      item_id: "9007199254740993",
      column_values: columns,
    })
    expect(JSON.parse(calls[0].variables.column_values as string)).toEqual(columns)
    expect(calls[0].variables.item_id).toBe("9007199254740993")
    expect(calls[0].query).toContain("create_labels_if_missing: false")
    await api.items.create({ board_id: "1", group_id: "topics", item_name: "New" })
    expect(calls[1].variables).not.toHaveProperty("column_values")
    await api.subitems.create({
      parent_item_id: "123",
      item_name: "Child",
      column_values: { status: { label: "Approved" } },
    })
    expect(calls[2].variables.parent_item_id).toBe("123")
    await api.items.moveToGroup({ item_id: "123", group_id: "done" })
    expect(calls[3].variables).toEqual({ item_id: "123", group_id: "done" })
  })
  test("paginates boards, users and updates and preserves editorial HTML", async () => {
    const update = {
      id: "9",
      body: "<p>Caption</p>",
      text_body: "Caption",
      created_at: null,
      updated_at: null,
      creator_id: null,
      replies: [],
    }
    mock((call) => {
      const rows = call.variables.page === 2 ? [] : [{ id: "1" }]
      if (call.query.includes("updates("))
        return response({
          items: [{ id: "123", updates: call.variables.page === 2 ? [] : [update] }],
        })
      if (call.query.includes("create_update(")) return response({ create_update: update })
      if (call.query.includes("edit_update(")) return response({ edit_update: update })
      return response({ boards: rows, users: rows })
    })
    const api = await client()
    expect(await collect(api.boards.listAll({ limit: 1, workspace_ids: ["10"] }))).toHaveLength(1)
    expect(await collect(api.users.listAll({ limit: 1 }))).toHaveLength(1)
    expect(await collect(api.updates.listAll({ item_id: "123", limit: 1 }))).toEqual([update])
    await api.updates.create({ item_id: "123", body: "<p>Caption</p>" })
    await api.updates.edit({ id: "9", body: "<p>Edited</p>" })
    expect(calls.at(-1)?.variables).toEqual({ id: "9", body: "<p>Edited</p>" })
  })
  test("returns asset metadata without fetching file URLs and retains raw external-link values", async () => {
    const asset = {
      id: "5",
      name: "Photo",
      public_url: "https://files.example.com/temp",
      file_extension: "jpg",
      file_size: 42,
      url: "https://files.example.com/photo",
      created_at: null,
    }
    const row = {
      ...item(),
      column_values: [
        {
          id: "files",
          type: "file",
          text: null,
          value: '{"files":[{"fileType":"LINK","linkToFile":"https://canva.example"}]}',
        },
      ],
    }
    mock(() => response({ assets: [asset], items: [{ ...row, assets: [asset] }] }))
    const api = await client()
    expect(await api.assets.get("5")).toEqual(asset)
    expect(await api.assets.forItem("123")).toEqual([asset])
    expect((await api.items.get("123"))?.column_values).toEqual(row.column_values)
    expect(calls.every((call) => call.url === "https://api.monday.com/v2")).toBe(true)
  })
  test("rejects invalid IDs, limits and lossy column values before transport", async () => {
    mock(() => response({}))
    const api = await client()
    for (const id of ["", "-1", "1.2", "https://example.com", "1) { users { id } }"])
      await expect(api.items.get(id)).rejects.toThrow("IDs")
    await expect(api.items.list({ board_id: "1", limit: 501 })).rejects.toThrow("limit")
    await expect(api.boards.list({ page: 0 })).rejects.toThrow("page")
    for (const column_values of [
      {},
      { status: undefined },
      { date: { date: undefined } },
      { status: { index: NaN } },
    ])
      await expect(
        api.items.changeColumns({
          board_id: "1",
          item_id: "123",
          column_values: column_values as unknown as MondayColumnWrites,
        })
      ).rejects.toThrow("[SixbMonday]")
    expect(calls).toHaveLength(0)
  })
})
