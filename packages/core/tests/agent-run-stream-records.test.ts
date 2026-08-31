import { describe, expect, test } from "bun:test"
import { InMemoryBroker } from "../src"
import { publishAgentRunFinished } from "../src/agents"
import {
  AGENT_ACTIVITY_STREAM_ID,
  agentRunActivityEvent,
  agentRunFinishedEvent,
  agentRunStreamId,
  agentRunStreamIdempotencyKey,
  isAgentRunActivityEvent,
  isAgentRunStreamEvent,
  publishAgentRunActivity,
} from "../src/agents/streams"
import type { AgentRunRecord } from "../src/storage"

const OCCURRED_AT = new Date("2026-01-02T03:04:05.000Z")
const FAILURE = {
  code: "internal.unexpected" as const,
  message: "boom",
  retryable: false,
  at: "2026-01-02T03:04:04.000Z",
  details: { agentId: "assistant", runId: "agt_run_1" },
}

function runRecord(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "agt_run_1",
    projectId: "stream-records-tests",
    executionId: "exec_agt_run_1",
    threadId: "agt_thr_1",
    agentId: "assistant",
    triggerMessageId: "agt_msg_1",
    requesterGroupIds: [],
    status: "cancelled",
    attempt: 0,
    createdAt: new Date("2026-01-02T03:00:00.000Z"),
    ...overrides,
  }
}

describe("agent run stream records", () => {
  test("builds and validates the low-frequency project activity event", () => {
    const event = agentRunActivityEvent(runRecord({ status: "running", attempt: 2 }), OCCURRED_AT)

    expect(event).toMatchObject({
      schemaVersion: 1,
      type: "agent.run.activity",
      runId: "agt_run_1",
      threadId: "agt_thr_1",
      status: "running",
      attempt: 2,
      occurredAt: OCCURRED_AT.toISOString(),
    })
    expect(isAgentRunActivityEvent(event)).toBe(true)
    expect(isAgentRunActivityEvent({ ...event, status: "thinking" })).toBe(false)
  })

  test("builds the finished event from a terminal run record", () => {
    const event = agentRunFinishedEvent(
      runRecord({ status: "failed", attempt: 2, finishReason: "error", error: FAILURE }),
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
      error: FAILURE,
      occurredAt: "2026-01-02T03:04:05.000Z",
    })
  })

  test("validates the exact durable failure on a finished event", () => {
    const event = agentRunFinishedEvent(
      runRecord({ status: "failed", error: FAILURE }),
      OCCURRED_AT
    )

    expect(isAgentRunStreamEvent(event)).toBe(true)
    expect(isAgentRunStreamEvent({ ...event, error: FAILURE.message })).toBe(false)
    expect(isAgentRunStreamEvent({ ...event, error: { ...FAILURE, retryable: true } })).toBe(false)
    expect(
      isAgentRunStreamEvent({ ...event, error: { ...FAILURE, code: "dataset.not_found" } })
    ).toBe(false)
  })

  test("validates compaction lifecycle events without exposing summary content", () => {
    const base = {
      schemaVersion: 1 as const,
      projectId: "stream-records-tests",
      runId: "agt_run_1",
      threadId: "agt_thr_1",
      agentId: "assistant",
      attempt: 1,
      occurredAt: OCCURRED_AT.toISOString(),
      reason: "threshold" as const,
    }
    const started = {
      ...base,
      type: "agent.compaction.started" as const,
      estimatedInputTokensBefore: 95_000,
    }
    const completed = {
      ...base,
      type: "agent.compaction.completed" as const,
      checkpointId: "agt_ctx_agt_run_1",
      estimatedInputTokensBefore: 95_000,
      estimatedInputTokensAfter: 30_000,
    }
    const failed = {
      ...base,
      type: "agent.compaction.failed" as const,
      errorCode: "summary_failed" as const,
    }

    expect(isAgentRunStreamEvent(started)).toBe(true)
    expect(isAgentRunStreamEvent(completed)).toBe(true)
    expect(isAgentRunStreamEvent(failed)).toBe(true)
    expect(isAgentRunStreamEvent({ ...started, estimatedInputTokensBefore: -1 })).toBe(false)
    expect(isAgentRunStreamEvent({ ...completed, checkpointId: 1 })).toBe(false)
    expect(isAgentRunStreamEvent({ ...failed, errorCode: "raw_provider_error" })).toBe(false)
    expect(Object.hasOwn(completed, "summary")).toBe(false)
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
        type: "agent.compaction.started",
        reason: "threshold",
        estimatedInputTokensBefore: 95_000,
      })
    ).toBe("agt_run_1:3:compaction:threshold:started")
    expect(
      agentRunStreamIdempotencyKey({
        ...base,
        type: "agent.compaction.completed",
        reason: "threshold",
        checkpointId: "agt_ctx_agt_run_1",
        estimatedInputTokensBefore: 95_000,
        estimatedInputTokensAfter: 30_000,
      })
    ).toBe("agt_run_1:3:compaction:agt_ctx_agt_run_1:completed")
    expect(
      agentRunStreamIdempotencyKey({
        ...base,
        type: "agent.compaction.failed",
        reason: "threshold",
        errorCode: "summary_failed",
      })
    ).toBe("agt_run_1:3:compaction:threshold:failed:summary_failed")
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

    const activity = await broker.read({
      projectId: run.projectId,
      streamId: AGENT_ACTIVITY_STREAM_ID,
    })
    expect(activity.records).toHaveLength(1)
    expect(activity.records[0]?.payload).toMatchObject({
      type: "agent.run.activity",
      runId: run.id,
      threadId: run.threadId,
      status: "cancelled",
    })
  })

  test("publishes queued activity without creating a per-run transcript stream", async () => {
    const broker = new InMemoryBroker()
    const run = runRecord({ status: "queued" })

    await publishAgentRunActivity(broker, run)

    const activity = await broker.read({
      projectId: run.projectId,
      streamId: AGENT_ACTIVITY_STREAM_ID,
    })
    expect(activity.records).toHaveLength(1)
    expect(activity.records[0]).toMatchObject({
      name: "agent.run.activity",
      key: run.threadId,
      payload: { status: "queued", runId: run.id },
    })
  })
})
