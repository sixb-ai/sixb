import { afterEach, describe, expect, test } from "bun:test"
import { createTestClient, empty, json, page, recorder, route } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("purchase orders", () => {
  test("are addressed by number, including their approval actions", async () => {
    const calls = recorder(() => empty())
    const fl = await createTestClient()

    await fl.purchaseOrders.update(1042, { description: "Filters" })
    await fl.purchaseOrders.submitForApproval(1042)
    await fl.purchaseOrders.approve(1042)
    await fl.purchaseOrders.reject(1042)
    await fl.purchaseOrders.purchase(1042)
    await fl.purchaseOrders.undoPurchase(1042)
    await fl.purchaseOrders.close(1042)

    expect(calls.map(route)).toEqual([
      "PATCH /api/purchase_orders/1042",
      "PATCH /api/purchase_orders/1042/submit_for_approval",
      "PATCH /api/purchase_orders/1042/approve",
      "PATCH /api/purchase_orders/1042/reject",
      "PATCH /api/purchase_orders/1042/purchase",
      "PATCH /api/purchase_orders/1042/undo_purchase",
      "PATCH /api/purchase_orders/1042/close",
    ])
  })

  test("line items live under the purchase order's number", async () => {
    const calls = recorder([page([]), json({ id: 1 }, { status: 201 })])
    const fl = await createTestClient()

    await fl.purchaseOrderLineItems.list(1042)
    await fl.purchaseOrderLineItems.create(1042, { part_id: 5, quantity: 2, unit_cost: 9.5 })

    expect(calls.map(route)).toEqual([
      "GET /api/purchase_orders/1042/purchase_order_line_items",
      "POST /api/purchase_orders/1042/purchase_order_line_items",
    ])
  })
})

describe("parts", () => {
  test("get asks for stock by part location", async () => {
    const calls = recorder([json({ id: 1 })])
    const fl = await createTestClient()

    await fl.parts.get(1, { withCrossReferenceMemberLocations: true, partLocationIds: [4, 5] })

    expect(route(calls[0]!)).toBe(
      "GET /api/parts/1?with_cross_reference_member_locations=true&part_location_id[]=4&part_location_id[]=5"
    )
  })

  test("inventory sets are listed under a part location detail", async () => {
    const calls = recorder([page([])])
    const fl = await createTestClient()

    await fl.partLocationDetails.listInventorySets(9)

    expect(route(calls[0]!)).toBe("GET /api/part_location_details/9/inventory_sets")
  })
})
