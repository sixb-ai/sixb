import { expect, test } from "bun:test"
import { agentContextLabel } from "../src/utils/contextDisplay"

test("object context labels remove redundant type prefixes and opaque identifiers", () => {
  expect(
    agentContextLabel({
      kind: "object",
      ref: {
        objectTypeId: "Conversation",
        primaryId: "conversation:targeting-assessment:765c59d984db6842",
      },
    })
  ).toBe("Conversation · Targeting assessment")

  expect(
    agentContextLabel({
      kind: "object",
      ref: {
        objectTypeId: "Message",
        primaryId: "message:conversation:targeting-assessment:765c59d984db6842",
      },
    })
  ).toBe("Message · Conversation targeting assessment")
})

test("object context labels stay useful for ordinary readable ids", () => {
  expect(
    agentContextLabel({
      kind: "object",
      ref: { objectTypeId: "Equipment", primaryId: "equipment-camden-rtu-2" },
    })
  ).toBe("Equipment · Camden rtu 2")

  expect(
    agentContextLabel({
      kind: "object",
      ref: {
        objectTypeId: "Customer",
        primaryId: "c5e239852caf47d198eae80a912f472f",
      },
    })
  ).toBe("Customer · c5e23985…")
})

test("app-state context keeps its authored label", () => {
  expect(
    agentContextLabel({
      kind: "app-state",
      id: "selected-message",
      label: "Selected outreach message",
      description: "The message currently selected in the app.",
      value: null,
    })
  ).toBe("Selected outreach message")
})
