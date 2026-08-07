import { describe, expect, test } from "bun:test"
import { createNorthlineScenario } from "../lib/scenario/create-scenario"
import { createScenarioClock } from "../lib/scenario/scenario-clock"
import {
  businessStateSchema,
  controlsStateSchema,
  fieldServiceStateSchema,
} from "../lib/sources/contracts"

describe("Northline scenario", () => {
  const scenario = createNorthlineScenario(
    createScenarioClock(new Date("2026-02-10T15:30:45.000Z"))
  )

  test("produces valid source documents from one fixed clock", () => {
    expect(() => businessStateSchema.parse(scenario.business)).not.toThrow()
    expect(() => fieldServiceStateSchema.parse(scenario.fieldService)).not.toThrow()
    expect(() => controlsStateSchema.parse(scenario.controls)).not.toThrow()
    expect(scenario.business.customers).toHaveLength(5)
    expect(scenario.business.quoteChanges).toHaveLength(scenario.business.quotes.length)
    expect(scenario.business.quoteChanges).toEqual(
      scenario.business.quotes.map((row) => ({ kind: "upsert", row }))
    )
    expect(scenario.controls.equipment).toHaveLength(10)
    expect(scenario.fieldService.technicians).toHaveLength(7)
    expect(scenario.controls.readings).toHaveLength(40)
  })

  test("keeps external references connected", () => {
    const customers = new Set(scenario.business.customers.map((row) => row.customer_id))
    const facilities = new Set(scenario.business.facilities.map((row) => row.facility_id))
    const equipment = new Set(scenario.controls.equipment.map((row) => row.equipment_id))
    const technicians = new Set(scenario.fieldService.technicians.map((row) => row.technician_id))

    expect(scenario.business.facilities.every((row) => customers.has(row.customer_id))).toBe(true)
    expect(scenario.business.contracts.every((row) => facilities.has(row.facility_id))).toBe(true)
    expect(scenario.controls.equipment.every((row) => facilities.has(row.facility_id))).toBe(true)
    expect(scenario.controls.alarms.every((row) => equipment.has(row.equipment_id))).toBe(true)
    expect(
      scenario.fieldService.workOrders.every(
        (row) =>
          equipment.has(row.equipment_id) &&
          (!row.technician_id || technicians.has(row.technician_id))
      )
    ).toBe(true)
  })

  test("keeps the Harbor Foods journey stable", () => {
    const alarm = scenario.controls.alarms.find((row) => row.alarm_id === "alarm-harbor-rtu-7-vfd")
    expect(alarm).toMatchObject({
      equipment_id: "equipment-harbor-newark-rtu-7",
      severity: "high",
      status: "active",
    })
    expect(alarm?.observed_at).toBe("2026-02-10T15:12:00.000Z")
  })
})
