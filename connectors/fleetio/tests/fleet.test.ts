import { afterEach, describe, expect, test } from "bun:test"
import { collect, createTestClient, empty, json, page, recorder, route } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("vehicles", () => {
  test("get takes a key:value external ID", async () => {
    const calls = recorder([json({ id: 1 })])
    const fl = await createTestClient()

    await fl.vehicles.get("vin:1FTFW1E50NFA00001")

    expect(route(calls[0]!)).toBe("GET /api/vehicles/vin:1FTFW1E50NFA00001")
  })

  test("sub-lists are scoped to the vehicle", async () => {
    const calls = recorder(() => page([]))
    const fl = await createTestClient()

    await fl.vehicles.listFuelEntries(3)
    await fl.vehicles.listMeterEntries(3)
    await fl.vehicles.listServiceEntries(3)
    await fl.vehicles.listAssignments(3)
    await fl.vehicles.listIssues(3)
    await fl.vehicles.listLinkedVehicles(3)

    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/api/vehicles/3/fuel_entries",
      "/api/vehicles/3/meter_entries",
      "/api/vehicles/3/service_entries",
      "/api/vehicles/3/vehicle_assignments",
      "/api/vehicles/3/issues",
      "/api/vehicles/3/linked_vehicles",
    ])
  })

  test("a sub-list iterator walks its pages under the vehicle", async () => {
    const calls = recorder([page([{ id: 1 }], { next_cursor: "n" }), page([{ id: 2 }])])
    const fl = await createTestClient()

    const issues = await collect(fl.vehicles.listAllIssues(3))

    expect(issues.map((issue) => issue.id)).toEqual([1, 2])
    expect(calls[1]?.url.pathname).toBe("/api/vehicles/3/issues")
    expect(calls[1]?.url.searchParams.get("start_cursor")).toBe("n")
  })

  test("single records under a vehicle, archive and restore", async () => {
    const calls = recorder([json({ id: 1 }), json({ id: 2 }), empty(), empty(), page([])])
    const fl = await createTestClient()

    await fl.vehicles.getCurrentAssignment(3)
    await fl.vehicles.getPurchaseDetail(3)
    await fl.vehicles.archive(3)
    await fl.vehicles.restore(3)
    await fl.vehicles.listArchived()

    expect(calls.map(route)).toEqual([
      "GET /api/vehicles/3/current_assignment",
      "GET /api/vehicles/3/purchase_detail",
      "PATCH /api/vehicles/3/archive",
      "PATCH /api/vehicles/3/restore",
      "GET /api/vehicles/archived",
    ])
  })
})

describe("search", () => {
  test("posts the list options as JSON and walks next_cursor in the body", async () => {
    const calls = recorder([page([{ id: 1 }], { next_cursor: "n" }), page([{ id: 2 }])])
    const fl = await createTestClient()

    const found = await collect(
      fl.vehicles.searchAll({ pageSize: 25, filter: { name: { like: "Truck" } } })
    )

    expect(found).toHaveLength(2)
    expect(route(calls[0]!)).toBe("POST /api/vehicles/search")
    expect(calls[0]?.body).toEqual({ per_page: 25, filter: { name: { like: "Truck" } } })
    expect(calls[1]?.body).toEqual({
      start_cursor: "n",
      per_page: 25,
      filter: { name: { like: "Truck" } },
    })
  })

  test("is retried like a read, because it changes nothing", async () => {
    const calls = recorder([
      json({ title: "Oops" }, { status: 500, headers: { "retry-after": "0" } }),
      page([]),
    ])
    const fl = await createTestClient()

    await fl.contacts.search()

    expect(calls).toHaveLength(2)
  })
})

describe("archiving", () => {
  test("contacts and vendors have archived lists, archive and restore", async () => {
    const calls = recorder([page([]), empty(), page([]), empty(), page([])])
    const fl = await createTestClient()

    await fl.contacts.listArchived()
    await fl.contacts.archive(1)
    await fl.contacts.searchArchived()
    await fl.vendors.restore(2)
    await fl.vendors.listArchived()

    expect(calls.map(route)).toEqual([
      "GET /api/contacts/archived",
      "PATCH /api/contacts/1/archive",
      "POST /api/contacts/archived/search",
      "PATCH /api/vendors/2/restore",
      "GET /api/vendors/archived",
    ])
  })
})

describe("contacts", () => {
  test("get repeats expand[] for each requested attribute", async () => {
    const calls = recorder([json({ id: 1 })])
    const fl = await createTestClient()

    await fl.contacts.get(1, { expand: ["group"] })

    expect(route(calls[0]!)).toBe("GET /api/contacts/1?expand[]=group")
  })
})

describe("vehicle assignments", () => {
  test("unassign returns the assignment", async () => {
    const calls = recorder([json({ id: 4 })])
    const fl = await createTestClient()

    const assignment = await fl.vehicleAssignments.unassign(4)

    expect(route(calls[0]!)).toBe("PATCH /api/vehicle_assignments/4/unassign")
    expect(assignment.id).toBe(4)
  })
})
