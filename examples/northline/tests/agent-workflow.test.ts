import { describe, expect, test } from "bun:test"
import { lookupResponsePolicy } from "../ai/tools"
import { assessServiceCase } from "../workflows/agent-service-assessment"

describe("Northline agent workflow", () => {
  test("builds an explicit prompt that requires a call to its registered policy tool", () => {
    const prompt = assessServiceCase.prompt({
      input: {
        caseNumber: "SC-1042",
        alarmSeverity: "high",
        contractTier: "priority-24-7",
        summary: "RTU-7 supply fan VFD failed while the building is occupied.",
      },
    })

    expect(prompt).toContain("SC-1042")
    expect(prompt).toContain("priority-24-7")
    expect(prompt).toContain(lookupResponsePolicy.name)
    expect(assessServiceCase.toolNames).toContain(lookupResponsePolicy.name)
  })
})
