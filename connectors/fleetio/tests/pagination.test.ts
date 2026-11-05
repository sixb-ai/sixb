import { afterEach, describe, expect, test } from "bun:test"
import { collect, createTestClient, page, recorder, route } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("list", () => {
  test("flattens filters and sorts into Fleetio's nested parameters", async () => {
    const calls = recorder([page([{ id: 1 }])])
    const fl = await createTestClient()

    const result = await fl.workOrders.list({
      cursor: "abc",
      pageSize: 100,
      filter: {
        vehicle_id: { eq: 42 },
        updated_at: { gte: "2026-11-01T00:00:00Z" },
        labels: { include: ["brakes", "urgent"] },
        purchase_order_number: { like: "PO-" },
      },
      sort: { updated_at: "asc" },
    })

    expect(result.records).toEqual([{ id: 1 }] as never)
    const query = calls[0]?.url.searchParams
    expect(query?.get("start_cursor")).toBe("abc")
    expect(query?.get("per_page")).toBe("100")
    expect(query?.get("filter[vehicle_id][eq]")).toBe("42")
    expect(query?.get("filter[updated_at][gte]")).toBe("2026-11-01T00:00:00Z")
    expect(query?.get("filter[labels][include]")).toBe("brakes,urgent")
    expect(query?.get("filter[purchase_order_number][like]")).toBe("PO-")
    expect(query?.get("sort[updated_at]")).toBe("asc")
  })

  test("sends no parameters it was not given", async () => {
    const calls = recorder([page([])])
    const fl = await createTestClient()

    await fl.workOrders.list()

    expect(route(calls[0]!)).toBe("GET /api/work_orders")
  })
})

describe("listAll", () => {
  test("follows next_cursor and keeps the filter and sort on every page", async () => {
    const calls = recorder([
      page([{ id: 1 }, { id: 2 }], { next_cursor: "second" }),
      page([{ id: 3 }], { start_cursor: "second" }),
    ])
    const fl = await createTestClient()

    const orders = await collect(
      fl.workOrders.listAll({
        pageSize: 2,
        filter: { vehicle_id: { eq: 42 } },
        sort: { id: "asc" },
      })
    )

    expect(orders.map((order) => order.id)).toEqual([1, 2, 3])
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url.searchParams.has("start_cursor")).toBe(false)
    expect(calls[1]?.url.searchParams.get("start_cursor")).toBe("second")
    expect(calls[1]?.url.searchParams.get("filter[vehicle_id][eq]")).toBe("42")
    expect(calls[1]?.url.searchParams.get("sort[id]")).toBe("asc")
    expect(calls[1]?.url.searchParams.get("per_page")).toBe("2")
  })

  test("starts from the caller's cursor", async () => {
    const calls = recorder([page([{ id: 9 }], { start_cursor: "resume" })])
    const fl = await createTestClient()

    await collect(fl.workOrders.listAll({ cursor: "resume" }))

    expect(calls[0]?.url.searchParams.get("start_cursor")).toBe("resume")
  })

  test("throws instead of looping on a repeated cursor", async () => {
    const calls = recorder(() => page([{ id: 1 }], { next_cursor: "same" }))
    const fl = await createTestClient()

    const error = await collect(fl.workOrders.listAll()).catch((caught: unknown) => caught)

    expect(String(error)).toContain("repeated next_cursor")
    expect(calls).toHaveLength(2)
  })
})
