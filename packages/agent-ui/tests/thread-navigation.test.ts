import { describe, expect, test } from "bun:test"
import { nextThreadPageOffset, threadNavigationSections } from "../src/threadNavigation"
import type { Agent, AgentThread } from "../src/types"

const agents = new Map<string, Agent>([
  [
    "analyst",
    {
      id: "analyst",
      name: "Business Analyst",
      groupIds: [],
    },
  ],
  [
    "operator",
    {
      id: "operator",
      name: "Operations Agent",
      groupIds: [],
    },
  ],
])

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

describe("threadNavigationSections", () => {
  test("prioritizes active runs without disturbing order inside each section", () => {
    const sections = threadNavigationSections(
      [
        thread({ id: "idle-new", title: "Newest idle" }),
        thread({ id: "running", title: "Background work", activeRunId: "run-1" }),
        thread({ id: "idle-old", title: "Older idle" }),
      ],
      agents,
      ""
    )

    expect(sections.running.map((item) => item.id)).toEqual(["running"])
    expect(sections.recent.map((item) => item.id)).toEqual(["idle-new", "idle-old"])
  })

  test("searches thread titles and agent names case-insensitively", () => {
    const threads = [
      thread({ id: "forecast", title: "Quarterly forecast" }),
      thread({ id: "ops", agentId: "operator", title: "Deploy service" }),
    ]

    expect(
      threadNavigationSections(threads, agents, "FORECAST").recent.map((item) => item.id)
    ).toEqual(["forecast"])
    expect(
      threadNavigationSections(threads, agents, "operations").recent.map((item) => item.id)
    ).toEqual(["ops"])
  })
})

describe("nextThreadPageOffset", () => {
  test("advances in stable 50-thread pages until the API is exhausted", () => {
    expect(nextThreadPageOffset(true, undefined)).toBe(50)
    expect(nextThreadPageOffset(true, "50")).toBe(100)
    expect(nextThreadPageOffset(true, "invalid")).toBe(50)
    expect(nextThreadPageOffset(false, "100")).toBeUndefined()
  })
})
