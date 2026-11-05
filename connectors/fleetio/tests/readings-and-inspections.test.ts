import { afterEach, describe, expect, test } from "bun:test"
import { createTestClient, empty, json, page, recorder, route } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("readings", () => {
  test("each entry type reaches its own route", async () => {
    const calls = recorder([page([]), page([]), page([]), page([])])
    const fl = await createTestClient()

    await fl.meterEntries.list()
    await fl.fuelEntries.list()
    await fl.expenseEntries.list()
    await fl.faults.list()

    expect(calls.map(route)).toEqual([
      "GET /api/meter_entries",
      "GET /api/fuel_entries",
      "GET /api/expense_entries",
      "GET /api/faults",
    ])
  })
})

describe("inspections", () => {
  test("submitted forms can be read and deleted, and schedules can include occurrences", async () => {
    const calls = recorder([json({ id: 1 }), empty(), json({ id: 2 })])
    const fl = await createTestClient()

    await fl.submittedInspectionForms.get(1)
    await fl.submittedInspectionForms.delete(1)
    await fl.inspectionSchedules.get(2, { includeOccurrences: 3 })

    expect(calls.map(route)).toEqual([
      "GET /api/submitted_inspection_forms/1",
      "DELETE /api/submitted_inspection_forms/1",
      "GET /api/inspection_schedules/2?include_occurrences=3",
    ])
  })
})

describe("read-only lookups", () => {
  test("reach their routes and offer no writes", async () => {
    const calls = recorder([page([]), page([]), page([]), page([]), page([])])
    const fl = await createTestClient()

    await fl.fuelTypes.list()
    await fl.expenseEntryTypes.list()
    await fl.equipmentStatuses.list()
    await fl.equipmentTypes.list()
    await fl.inventoryAdjustmentReasons.list()

    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/api/fuel_types",
      "/api/expense_entry_types",
      "/api/equipment_statuses",
      "/api/equipment_types",
      "/api/inventory_adjustment_reasons",
    ])
    expect("create" in fl.fuelTypes).toBe(false)
  })
})
