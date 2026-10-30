import { describe, expect, test } from "bun:test"
import type { ModelAssistantPart, ModelStep } from "@sixb/core/models"
import { subagentAnswer } from "../src/run-subagent"

function step(...content: ModelAssistantPart[]): ModelStep {
  return {
    content,
    finishReason: "stop",
    usage: {},
    responseId: "response",
    cost: { status: "unpriceable", reason: "missing-rate-card" },
  }
}

const text = (value: string): ModelAssistantPart => ({ type: "text", text: value })
const localCall = (id: string): ModelAssistantPart => ({
  type: "tool-call",
  toolCallId: id,
  toolName: "bash",
  input: {},
})
const providerSearch: ModelAssistantPart = {
  type: "tool-call",
  toolCallId: "search",
  toolName: "web_search",
  input: {},
  providerExecuted: true,
}

describe("a child's answer", () => {
  // Removal proof: read the last step alone; the answer split by a provider pause loses its first
  // half, and the answer given before a final tool call is lost.
  test("is everything it wrote after its last local tool, through a provider pause", () => {
    expect(
      subagentAnswer([
        step(text("Let me look."), localCall("ls")),
        step(text("Revenue rose 12%."), providerSearch),
        step(text("Margins held at 31%.")),
      ])
    ).toBe("Revenue rose 12%.\nMargins held at 31%.")
  })

  test("is the last text it wrote when nothing follows its last tool", () => {
    expect(
      subagentAnswer([
        step(text("Let me look."), localCall("ls")),
        step(text("Revenue rose 12%."), localCall("publish")),
        step(),
      ])
    ).toBe("Revenue rose 12%.")
  })

  test("is empty when it wrote nothing", () => {
    expect(subagentAnswer([step(localCall("ls")), step()])).toBe("")
  })
})
