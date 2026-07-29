import { describe, expect, test } from "bun:test"
import { serviceCaseIdentity } from "../lib/case-policy"

describe("service-case identity", () => {
  test("preserves the canonical Harbor Foods case number", () => {
    expect(serviceCaseIdentity("alarm-harbor-rtu-7-vfd")).toEqual({
      id: "case-sc-1042",
      number: "SC-1042",
    })
  })

  test("is deterministic for alarms outside the fixture", () => {
    const first = serviceCaseIdentity("alarm-new-source-id")
    expect(serviceCaseIdentity("alarm-new-source-id")).toEqual(first)
    expect(first.id).toBe(`case-${first.number.toLowerCase()}`)
  })
})
