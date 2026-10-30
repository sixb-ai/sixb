import { describe, expect, test } from "bun:test"
import { InMemoryBroker } from "../src"
import { publishAgentRunFinished } from "../src/agents"
import {
  AGENT_ACTIVITY_STREAM_ID,
  agentRunActivityEvent,
  agentRunFinishedEvent,
  agentRunInboxStreamId,
  agentRunStreamId,
  agentRunStreamIdempotencyKey,
  isAgentRunActivityEvent,
  isAgentRunStreamEvent,
  publishAgentChildFinished,
  publishAgentRunActivity,
  subscribeAgentInbox,
} from "../src/agents/streams/protocol"
import { MODEL_UI_CHUNK_TYPES, type ModelUiChunk } from "../src/models/events"
import type { ConversationAgentRunRecord, SubagentRunRecord } from "../src/storage"

const OCCURRED_AT = new Date("2026-01-02T03:04:05.000Z")
const FAILURE = {
  code: "internal.unexpected" as const,
  message: "boom",
  retryable: false,
  at: "2026-01-02T03:04:04.000Z",
  details: { agentId: "assistant", runId: "agt_run_1" },
}

function runRecord(
  overrides: Partial<ConversationAgentRunRecord> = {}
): ConversationAgentRunRecord {
  return {
    kind: "conversation",
    id: "agt_run_1",
    projectId: "stream-records-tests",
    executionId: "exec_agt_run_1",
    threadId: "agt_thr_1",
    triggerMessageId: "agt_msg_1",
    status: "cancelled",
    attempt: 0,
    createdAt: new Date("2026-01-02T03:00:00.000Z"),
    ...overrides,
  }
}

function subagentRunRecord(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    kind: "subagent",
    id: "agt_run_child_1",
    projectId: "stream-records-tests",
    executionId: "exec_agt_run_child_1",
    threadId: "agt_thr_child_1",
    triggerMessageId: "agt_msg_child_1",
    parentRunId: "agt_run_1",
    spawnKey: "research",
    spec: {
      model: { provider: "gateway", modelId: "openai/gpt-5" },
      task: "Research the delegated question.",
      toolNames: [],
    },
    status: "cancelled",
    attempt: 1,
    createdAt: new Date("2026-01-02T03:00:00.000Z"),
    ...overrides,
  }
}

describe("agent run stream records", () => {
  test("builds, validates, and publishes the project activity event keyed by its thread", async () => {
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
    // Regression proof: restoring agentId in either event builder fails these absence checks.
    expect(event).not.toHaveProperty("agentId")
    expect(isAgentRunActivityEvent({ ...event, status: "thinking" })).toBe(false)

    const broker = new InMemoryBroker()
    const queued = runRecord({ status: "queued" })
    await publishAgentRunActivity(broker, queued)
    const activity = await broker.read({
      projectId: queued.projectId,
      streamId: AGENT_ACTIVITY_STREAM_ID,
    })
    expect(activity.records).toHaveLength(1)
    expect(activity.records[0]).toMatchObject({
      name: "agent.run.activity",
      key: queued.threadId,
      payload: { status: "queued", runId: queued.id },
    })
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
      attempt: 2,
      status: "failed",
      finishReason: "error",
      error: FAILURE,
      occurredAt: "2026-01-02T03:04:05.000Z",
    })
  })

  test("uses parent lineage for a headless child stream", async () => {
    const broker = new InMemoryBroker()
    const run = subagentRunRecord()
    const event = agentRunFinishedEvent(run, OCCURRED_AT)

    expect(event).toEqual({
      schemaVersion: 1,
      type: "agent.run.finished",
      projectId: "stream-records-tests",
      runId: "agt_run_child_1",
      parentRunId: "agt_run_1",
      attempt: 1,
      status: "cancelled",
      occurredAt: "2026-01-02T03:04:05.000Z",
    })
    expect(isAgentRunStreamEvent(event)).toBe(true)
    expect(isAgentRunStreamEvent({ ...event, threadId: "agt_thr_1", agentId: "legacy" })).toBe(
      false
    )

    await publishAgentRunFinished(broker, run)
    const activity = await broker.read({
      projectId: run.projectId,
      streamId: AGENT_ACTIVITY_STREAM_ID,
    })
    expect(activity.records).toHaveLength(0)
    // Its parent hears it on its inbox instead.
    const inbox = await broker.read({
      projectId: run.projectId,
      streamId: agentRunInboxStreamId(run.parentRunId),
    })
    expect(inbox.records).toMatchObject([
      {
        name: "agent.child.finished",
        payload: { runId: run.id, parentRunId: run.parentRunId, status: "cancelled" },
      },
    ])
  })

  // Removal proof: drop the parent check from subscribeAgentInbox; the finish of another run's
  // child, written to this inbox, reads as this run's.
  test("tells a parent each of its children that finished, and no other run's", async () => {
    const broker = new InMemoryBroker()
    const run = subagentRunRecord()
    let heard!: (runIds: readonly string[]) => void
    const finished = new Promise<readonly string[]>((resolve) => {
      heard = resolve
    })
    const unsubscribe = await subscribeAgentInbox(
      broker,
      { projectId: run.projectId, inbox: { runId: run.parentRunId } },
      { mail: () => {}, childFinished: (runIds) => heard(runIds) }
    )
    try {
      // Written first, so the first thing heard proves they are left out. Still at work: nothing
      // to hear.
      await publishAgentChildFinished(broker, subagentRunRecord({ status: "running" }))
      await broker.append({
        projectId: run.projectId,
        streamId: agentRunInboxStreamId(run.parentRunId),
        records: [
          {
            name: "agent.child.finished",
            payload: { runId: "agt_run_child_2", parentRunId: "agt_run_2", status: "succeeded" },
          },
        ],
      })
      await publishAgentChildFinished(broker, run)

      expect(await finished).toEqual([run.id])
    } finally {
      unsubscribe()
    }
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

  test("validates each UI chunk variant by the fields it requires", () => {
    const base = {
      schemaVersion: 1 as const,
      type: "agent.ui.chunk" as const,
      projectId: "stream-records-tests",
      runId: "agt_run_1",
      threadId: "agt_thr_1",
      attempt: 1,
      occurredAt: OCCURRED_AT.toISOString(),
      chunkIndex: 0,
    }
    const tool = { toolCallId: "call-1", toolName: "quote_shipping" }
    const chunks: { readonly [TType in ModelUiChunk["type"]]: ModelUiChunk & { type: TType } } = {
      "start-step": { type: "start-step" },
      "text-start": { type: "text-start", id: "text" },
      "text-delta": { type: "text-delta", id: "text", delta: "Hi" },
      "text-end": { type: "text-end", id: "text" },
      "reasoning-start": { type: "reasoning-start", id: "reasoning" },
      "reasoning-delta": { type: "reasoning-delta", id: "reasoning", delta: "Hm" },
      "reasoning-end": { type: "reasoning-end", id: "reasoning" },
      "tool-input-start": { type: "tool-input-start", ...tool },
      "tool-input-delta": { type: "tool-input-delta", ...tool, inputTextDelta: "{" },
      "tool-input-available": { type: "tool-input-available", ...tool, input: null },
      "tool-input-error": { type: "tool-input-error", ...tool, input: "{", errorText: "Bad" },
      "tool-output-available": { type: "tool-output-available", ...tool, output: { price: 42 } },
      "tool-output-error": { type: "tool-output-error", ...tool, errorText: "Failed" },
      error: { type: "error", errorText: "Stream failed" },
    }

    expect(Object.keys(chunks).sort()).toEqual([...MODEL_UI_CHUNK_TYPES].sort())
    for (const chunk of Object.values(chunks)) {
      expect(isAgentRunStreamEvent({ ...base, chunk })).toBe(true)
    }

    // A newer producer may add optional fields to a known chunk.
    expect(isAgentRunStreamEvent({ ...base, chunk: { ...chunks["text-end"], extra: 1 } })).toBe(
      true
    )

    const malformed = [
      null,
      { id: "text", delta: "Hi" },
      { type: "text-start" },
      { type: "text-delta", id: "text" },
      { type: "reasoning-delta", id: "reasoning", delta: 1 },
      { type: "tool-input-start", toolCallId: "call-1" },
      { type: "tool-input-delta", ...tool },
      { type: "tool-input-available", ...tool },
      { type: "tool-input-error", ...tool, input: "{" },
      { type: "tool-output-available", ...tool },
      { type: "tool-output-error", toolName: "quote_shipping", errorText: "Failed" },
      { type: "error" },
    ]
    for (const chunk of malformed) {
      expect(isAgentRunStreamEvent({ ...base, chunk })).toBe(false)
    }
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
      agentRunStreamIdempotencyKey({
        ...base,
        type: "agent.ui.chunk",
        chunkIndex: 7,
        chunk: { type: "start-step" },
      })
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
})
