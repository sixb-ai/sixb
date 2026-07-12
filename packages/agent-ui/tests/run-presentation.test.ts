import { describe, expect, test } from "bun:test"
import {
  DELAYED_WAITING_COPY_MS,
  findPreStreamFailedRun,
  shouldShowDelayedWaitingCopy,
} from "../src/runPresentation"
import type { AgentMessage, AgentRun } from "../src/types"

function run(input: Partial<AgentRun> & Pick<AgentRun, "id" | "status">): AgentRun {
  const { id, status, ...overrides } = input
  return {
    projectId: "project",
    threadId: "thread",
    agentId: "assistant",
    triggerMessageId: "message-user",
    requestedByPrincipal: { type: "system", id: "system" },
    attempt: 0,
    streamId: `agents.runs.${id}`,
    createdAt: "2026-07-12T10:00:00.000Z",
    ...overrides,
    id,
    status,
  }
}

function assistantMessage(runId: string): AgentMessage {
  return {
    id: `message-${runId}`,
    projectId: "project",
    threadId: "thread",
    runId,
    role: "assistant",
    seq: 2,
    parts: [{ type: "text", text: "Done" }],
    annotations: [],
    contentVersion: 1,
    createdAt: "2026-07-12T10:00:01.000Z",
  }
}

describe("agent run presentation", () => {
  test("delays extra waiting copy for queued runs only", () => {
    const queued = run({ id: "queued", status: "queued" })
    const createdAt = Date.parse(queued.createdAt)

    expect(shouldShowDelayedWaitingCopy(queued, createdAt + DELAYED_WAITING_COPY_MS - 1)).toBe(
      false
    )
    expect(shouldShowDelayedWaitingCopy(queued, createdAt + DELAYED_WAITING_COPY_MS)).toBe(true)
    expect(
      shouldShowDelayedWaitingCopy(
        run({ id: "running", status: "running" }),
        createdAt + DELAYED_WAITING_COPY_MS
      )
    ).toBe(false)
  })

  test("shows only the newest failed run that has no assistant message", () => {
    const failed = run({ id: "failed", status: "failed" })
    expect(findPreStreamFailedRun([failed], [])?.id).toBe("failed")
    expect(findPreStreamFailedRun([failed], [assistantMessage(failed.id)])).toBeNull()

    const retry = run({ id: "retry", status: "succeeded" })
    expect(findPreStreamFailedRun([retry, failed], [])).toBeNull()
  })
})
