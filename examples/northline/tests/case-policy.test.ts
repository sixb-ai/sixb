import { describe, expect, test } from "bun:test"
import { serviceCaseIdentity } from "../lib/case-policy"

describe("service-case identity", () => {
  test("keeps fixture case numbers canonical and is deterministic for other alarms", () => {
    expect(serviceCaseIdentity("alarm-harbor-rtu-7-vfd")).toEqual({
      id: "case-sc-1042",
      number: "SC-1042",
    })
    const first = serviceCaseIdentity("alarm-new-source-id")
    expect(serviceCaseIdentity("alarm-new-source-id")).toEqual(first)
    expect(first.id).toBe(`case-${first.number.toLowerCase()}`)
  })
})
