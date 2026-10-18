import { expect, test } from "bun:test"
import type { AgentContextInput } from "@sixb/core/agents/context"
import { agentContextLabel } from "../src/agent/utils/context-display"

const object = (objectTypeId: string, primaryId: string): AgentContextInput => ({
  kind: "object",
  ref: { objectTypeId, primaryId },
})

test.each<[string, AgentContextInput, string]>([
  [
    "drops a redundant type prefix and an opaque suffix",
    object("Conversation", "conversation:targeting-assessment:765c59d984db6842"),
    "Conversation · Targeting assessment",
  ],
  [
    "keeps the readable segments of a nested id",
    object("Message", "message:conversation:targeting-assessment:765c59d984db6842"),
    "Message · Conversation targeting assessment",
  ],
  [
    "humanizes an ordinary readable id",
    object("Equipment", "equipment-camden-rtu-2"),
    "Equipment · Camden rtu 2",
  ],
  [
    "shortens an id that is only opaque",
    object("Customer", "c5e239852caf47d198eae80a912f472f"),
    "Customer · c5e23985…",
  ],
  [
    "keeps an app-state context's authored label",
    {
      kind: "app-state",
      id: "selected-message",
      label: "Selected outreach message",
      description: "The message currently selected in the app.",
      value: null,
    },
    "Selected outreach message",
  ],
])("context label %s", (_reason, context, label) => {
  expect(agentContextLabel(context)).toBe(label)
})
