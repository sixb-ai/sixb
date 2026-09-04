import { describe, expect, test } from "bun:test"
import { filterThreadNavigation } from "../src/threadNavigation"
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

describe("filterThreadNavigation", () => {
  test("preserves date order regardless of run activity", () => {
    const visible = filterThreadNavigation(
      [
        thread({ id: "idle-new", title: "Newest idle" }),
        thread({ id: "running", title: "Background work", activeRunId: "run-1" }),
        thread({ id: "idle-old", title: "Older idle" }),
      ],
      ""
    )

    expect(visible.map((item) => item.id)).toEqual(["idle-new", "running", "idle-old"])
  })

  test("searches thread titles case-insensitively", () => {
    const threads = [
      thread({ id: "forecast", title: "Quarterly forecast" }),
      thread({ id: "ops", agentId: "operator", title: "Deploy service" }),
    ]

    expect(filterThreadNavigation(threads, "FORECAST").map((item) => item.id)).toEqual(["forecast"])
    expect(filterThreadNavigation(threads, "operations")).toEqual([])
  })
})
