import { afterEach, describe, expect, test } from "bun:test"
import { collect, createTestClient, empty, json, page, recorder, route } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("work orders", () => {
  test("get, create, update and delete hit Fleetio's routes", async () => {
    const calls = recorder([
      json({ id: 7, number: "12", work_order_line_items: [] }),
      json({ id: 8 }, { status: 201 }),
      json({ id: 8, description: "Updated" }),
      empty(),
    ])
    const fl = await createTestClient()

    const shown = await fl.workOrders.get(7)
    const created = await fl.workOrders.create({
      vehicle_id: 1,
      work_order_status_id: 2,
      issued_at: "2026-11-05T09:00:00Z",
      work_order_line_items_attributes: [
        { type: "WorkOrderFreeTextLineItem", description: "Inspect brakes" },
      ],
    })
    const updated = await fl.workOrders.update(8, { description: "Updated" })
    const removed = await fl.workOrders.delete(8)

    expect(calls.map(route)).toEqual([
      "GET /api/work_orders/7",
      "POST /api/work_orders",
      "PATCH /api/work_orders/8",
      "DELETE /api/work_orders/8",
    ])
    expect(shown.number).toBe("12")
    expect(created.id).toBe(8)
    expect(calls[1]?.headers.get("content-type")).toBe("application/json")
    expect(calls[1]?.body).toEqual({
      vehicle_id: 1,
      work_order_status_id: 2,
      issued_at: "2026-11-05T09:00:00Z",
      work_order_line_items_attributes: [
        { type: "WorkOrderFreeTextLineItem", description: "Inspect brakes" },
      ],
    })
    expect(updated.description).toBe("Updated")
    expect(removed).toBeUndefined()
  })
})

describe("work order line items", () => {
  test("every method addresses the line item under its work order", async () => {
    const calls = recorder([
      page([{ id: 1 }]),
      json({ id: 1, item_name: "Brakes" }),
      json({ id: 2 }, { status: 201 }),
      empty(),
      empty(),
    ])
    const fl = await createTestClient()

    await fl.workOrderLineItems.list(7, { sort: { id: "asc" } })
    const item = await fl.workOrderLineItems.get(7, 1)
    await fl.workOrderLineItems.create(7, {
      type: "WorkOrderServiceTaskLineItem",
      item_type: "ServiceTask",
      item_id: 12345,
      work_order_sub_line_items_attributes: [
        { item_type: "Part", item_id: 101, unit_cost: 9.95, quantity: 2 },
        { item_type: "Contact", item_id: 4455, unit_cost: 24, quantity: 0.5 },
      ],
    })
    const updated = await fl.workOrderLineItems.update(7, 2, { description: "Pads" })
    await fl.workOrderLineItems.delete(7, 2)

    expect(calls.map(route)).toEqual([
      "GET /api/work_orders/7/work_order_line_items?sort[id]=asc",
      "GET /api/work_orders/7/work_order_line_items/1",
      "POST /api/work_orders/7/work_order_line_items",
      "PATCH /api/work_orders/7/work_order_line_items/2",
      "DELETE /api/work_orders/7/work_order_line_items/2",
    ])
    expect(item.item_name).toBe("Brakes")
    expect(updated).toBeUndefined()
  })

  test("listAll walks a work order's line items", async () => {
    const calls = recorder([page([{ id: 1 }], { next_cursor: "n" }), page([{ id: 2 }])])
    const fl = await createTestClient()

    const items = await collect(fl.workOrderLineItems.listAll(7))

    expect(items.map((item) => item.id)).toEqual([1, 2])
    expect(calls[1]?.url.pathname).toBe("/api/work_orders/7/work_order_line_items")
  })
})

describe("lookups", () => {
  test("work order statuses are read-only and VMRS reasons are a plain array", async () => {
    const calls = recorder([
      page([{ id: 1, name: "Open" }]),
      json({ id: 1, name: "Open" }),
      json([{ id: 3, name: "Breakdown" }]),
    ])
    const fl = await createTestClient()

    await fl.workOrderStatuses.list({ filter: { name: { like: "Op" } } })
    await fl.workOrderStatuses.get(1)
    const reasons = await fl.vmrsReasonsForRepair.list()

    expect(calls.map(route)).toEqual([
      "GET /api/work_order_statuses?filter[name][like]=Op",
      "GET /api/work_order_statuses/1",
      "GET /api/vmrs_reason_for_repairs",
    ])
    expect(reasons[0]?.name).toBe("Breakdown")
  })
})
