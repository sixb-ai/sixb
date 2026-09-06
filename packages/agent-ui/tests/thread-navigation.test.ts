import { describe, expect, test } from "bun:test"
import { agentThreadTitle } from "../src/threadNavigation"
import type { AgentThread } from "../src/types"

function thread(overrides: Partial<AgentThread> & Pick<AgentThread, "id">): AgentThread {
  const { id, ...rest } = overrides
  return {
    id,
    projectId: "project",
    agentId: "analyst",
    ownerPrincipal: { type: "user", id: "user" },
    status: "active",
    activeRunId: null,
    messageCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...rest,
  }
}

describe("thread switcher presentation", () => {
  test("uses readable fallback titles", () => {
    expect(agentThreadTitle(null)).toBe("New thread")
    expect(agentThreadTitle(thread({ id: "untitled", title: " " }))).toBe("Untitled chat")
  })
})
