import { describe, expect, test } from "bun:test"
import { agentThreadState } from "../src/agent/thread-reader-state"
import type { AgentThread } from "../src/agent/types"
import type { CurrentUser } from "../src/session"

type StateSources = Pick<AgentThread, "activeRunId" | "lastRun" | "read">
type LastRun = NonNullable<StateSources["lastRun"]>

const alice: CurrentUser = { id: "usr_alice", email: "alice@example.com", groupIds: [] }
const bob: CurrentUser = { id: "usr_bob", email: "bob@example.com", groupIds: [] }

function thread(overrides: Partial<StateSources> = {}): StateSources {
  return { activeRunId: null, ...overrides }
}

/** The reader's place: `unread` messages past it, and when they last looked. */
function read(unread: number, readAt?: string): NonNullable<StateSources["read"]> {
  return {
    threadId: "thr_1",
    throughSeq: 3 - unread,
    headSeq: 3,
    unread,
    ...(readAt === undefined ? {} : { readAt }),
  }
}

/** A turn Alice asked for that failed at 10:00. */
function failed(overrides: Partial<LastRun> = {}): LastRun {
  return {
    id: "run_1",
    status: "failed",
    errorCode: "internal.unexpected",
    completedAt: "2026-06-23T10:00:00.000Z",
    requestedBy: { type: "user", id: alice.id },
    ...overrides,
  }
}

const as = (user: CurrentUser | null, waiting = false) => ({ waiting, user })

describe("a thread's state for one reader", () => {
  test("a call waiting on them wins over everything else", () => {
    expect(agentThreadState(thread({ activeRunId: "run_2", read: read(2) }), as(alice, true))).toBe(
      "needs-you"
    )
  })

  test("their own turn that ended short needs them until they look", () => {
    expect(agentThreadState(thread({ lastRun: failed(), read: read(0) }), as(alice))).toBe(
      "needs-you"
    )
    expect(
      agentThreadState(
        thread({
          lastRun: failed({ status: "cancelled", finishReason: "interrupted" }),
          read: read(0),
        }),
        as(alice)
      )
    ).toBe("needs-you")

    // Removal proof: drop the `readAt` comparison; Done never settles a failed turn.
    expect(
      agentThreadState(
        thread({ lastRun: failed(), read: read(0, "2026-06-23T10:05:00.000Z") }),
        as(alice)
      )
    ).toBe("idle")
    expect(
      agentThreadState(
        thread({ lastRun: failed(), read: read(0, "2026-06-23T09:00:00.000Z") }),
        as(alice)
      )
    ).toBe("needs-you")
  })

  test("someone else's turn that ended short is news, not theirs to run again", () => {
    // Removal proof: drop the requester check; Bob is asked to retry a turn only Alice can.
    expect(agentThreadState(thread({ lastRun: failed(), read: read(0) }), as(bob))).toBe("finished")
  })

  test("a conversation too long for its model is news: running it again fails the same way", () => {
    expect(
      agentThreadState(
        thread({
          lastRun: failed({ errorCode: "agent.context_limit_exceeded" }),
          read: read(0),
        }),
        as(alice)
      )
    ).toBe("finished")
  })

  test("a turn in flight is working, whatever they have not read", () => {
    expect(agentThreadState(thread({ activeRunId: "run_2", read: read(2) }), as(alice))).toBe(
      "working"
    )
  })

  test("finished when something arrived, idle when they are caught up", () => {
    const done: LastRun = { id: "run_1", status: "succeeded", finishReason: "stop" }

    expect(agentThreadState(thread({ lastRun: done, read: read(1) }), as(alice))).toBe("finished")
    expect(agentThreadState(thread({ lastRun: done, read: read(0) }), as(alice))).toBe("idle")
  })

  test("without a place in the thread, only approvals and running turns show", () => {
    expect(agentThreadState(thread({ lastRun: failed() }), as(null))).toBe("idle")
    expect(agentThreadState(thread({ activeRunId: "run_2" }), as(null))).toBe("working")
    expect(agentThreadState(thread(), as(null, true))).toBe("needs-you")
  })
})
