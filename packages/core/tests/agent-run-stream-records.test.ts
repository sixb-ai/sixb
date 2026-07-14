import { describe, expect, test } from "bun:test"
import type { AgentRunRecord } from "../src"
import {
  agentRunFinishedEvent,
  agentRunStreamId,
  agentRunStreamIdempotencyKey,
  InMemoryBroker,
  publishAgentRunFinished,
} from "../src"

const OCCURRED_AT = new Date("2026-01-02T03:04:05.000Z")

function runRecord(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "agt_run_1",
    projectId: "stream-records-tests",
    threadId: "agt_thr_1",
    agentId: "assistant",
    triggerMessageId: "agt_msg_1",
    requestedByPrincipal: { type: "user", id: "user-1" },
    status: "cancelled",
    attempt: 0,
    createdAt: new Date("2026-01-02T03:00:00.000Z"),
    ...overrides,
  }
}

describe("agent run stream records", () => {
  test("builds the finished event from a terminal run record", () => {
    const event = agentRunFinishedEvent(
      runRecord({ status: "failed", attempt: 2, finishReason: "error", error: "boom" }),
      OCCURRED_AT
    )

    expect(event).toEqual({
      schemaVersion: 1,
      type: "agent.run.finished",
      projectId: "stream-records-tests",
      runId: "agt_run_1",
      threadId: "agt_thr_1",
      agentId: "assistant",
      attempt: 2,
      status: "failed",
      finishReason: "error",
      error: "boom",
      occurredAt: "2026-01-02T03:04:05.000Z",
    })
  })

  test("refuses to build a finished event for a non-terminal run", () => {
    expect(() => agentRunFinishedEvent(runRecord({ status: "queued" }))).toThrow("not terminal")
    expect(() => agentRunFinishedEvent(runRecord({ status: "running" }))).toThrow("not terminal")
  })

  test("keeps the idempotency-key vocabulary stable for every event type", () => {
    const finished = agentRunFinishedEvent(runRecord({ status: "cancelled" }), OCCURRED_AT)
    expect(agentRunStreamIdempotencyKey(finished)).toBe("agt_run_1:0:finished:cancelled")

    const base = {
      schemaVersion: 1 as const,
      projectId: "stream-records-tests",
      runId: "agt_run_1",
      threadId: "agt_thr_1",
      agentId: "assistant",
      attempt: 3,
      occurredAt: OCCURRED_AT.toISOString(),
    }
    expect(agentRunStreamIdempotencyKey({ ...base, type: "agent.run.started" })).toBe(
      "agt_run_1:3:started"
    )
    expect(
      agentRunStreamIdempotencyKey({ ...base, type: "agent.ui.chunk", chunkIndex: 7, chunk: null })
    ).toBe("agt_run_1:3:chunk:7")
    expect(
      agentRunStreamIdempotencyKey({
        ...base,
        type: "agent.message.finalized",
        messageId: "agt_msg_9",
      })
    ).toBe("agt_run_1:3:message:agt_msg_9:finalized")
  })

  test("publishes the terminal record onto the run stream", async () => {
    const broker = new InMemoryBroker()
    const run = runRecord()

    await publishAgentRunFinished(broker, run)

    const page = await broker.read({
      projectId: run.projectId,
      streamId: agentRunStreamId(run.id),
    })
    expect(page.records).toHaveLength(1)
    const record = page.records[0]
    expect(record?.name).toBe("agent.run.finished")
    expect(record?.key).toBe(run.id)
    expect(record?.payload).toMatchObject({
      type: "agent.run.finished",
      runId: run.id,
      status: "cancelled",
      attempt: 0,
    })
  })
})
