import { describe, expect, test } from "bun:test"
import { agentThreadState } from "../src/agent/thread-reader-state"
import type { AgentThread } from "../src/agent/types"

type StateSources = Pick<AgentThread, "activeRunId" | "lastRun" | "read">

function thread(overrides: Partial<StateSources> = {}): StateSources {
  return { activeRunId: null, ...overrides }
}

const read = (unread: number): NonNullable<StateSources["read"]> => ({
  threadId: "thr_1",
  throughSeq: 3 - unread,
  headSeq: 3,
  unread,
})

describe("a thread's state for one reader", () => {
  test("something waiting on them wins over everything else", () => {
    expect(agentThreadState(thread({ activeRunId: "run_1", read: read(2) }), true)).toBe(
      "needs-you"
    )
  })

  test("a turn that ended short needs them, even with no message unread", () => {
    expect(agentThreadState(thread({ lastRun: { id: "run_1", status: "failed" } }), false)).toBe(
      "needs-you"
    )
    expect(
      agentThreadState(
        thread({ lastRun: { id: "run_1", status: "cancelled", finishReason: "interrupted" } }),
        false
      )
    ).toBe("needs-you")
  })

  test("a turn in flight is working, whatever they have not read", () => {
    expect(agentThreadState(thread({ activeRunId: "run_1", read: read(2) }), false)).toBe("working")
  })

  test("finished when something arrived, idle when they are caught up", () => {
    expect(
      agentThreadState(
        thread({
          lastRun: { id: "run_1", status: "succeeded", finishReason: "stop" },
          read: read(1),
        }),
        false
      )
    ).toBe("finished")
    expect(
      agentThreadState(
        thread({
          lastRun: { id: "run_1", status: "succeeded", finishReason: "stop" },
          read: read(0),
        }),
        false
      )
    ).toBe("idle")
  })

  test("a thread never read has everything new", () => {
    expect(agentThreadState(thread({ read: read(2) }), false)).toBe("finished")
    expect(agentThreadState(thread(), false)).toBe("idle")
  })
})
