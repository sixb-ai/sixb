import { describe, expect, test } from "bun:test"
import { InMemoryBroker } from "@sixb/core"
import { AGENT_ACTIVITY_STREAM_ID } from "@sixb/core/agents/streams"
import { agentRunInboxStreamId } from "@sixb/core/internal/agents"
import type { ConversationAgentRunRecord, SubagentRunRecord } from "@sixb/core/storage"
import { NOOP_STREAM_SINK, withAgentActivityStream } from "../src/agents/run-events"

function runRecord(status: ConversationAgentRunRecord["status"]): ConversationAgentRunRecord {
  return {
    kind: "conversation",
    id: "run-1",
    projectId: "project",
    executionId: "execution-1",
    threadId: "thread-1",
    triggerMessageId: "message-1",
    status,
    attempt: status === "queued" ? 0 : 1,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  }
}

describe("withAgentActivityStream", () => {
  test("publishes lifecycle activity even when transcript streaming is replaced", async () => {
    const broker = new InMemoryBroker()
    const sink = withAgentActivityStream(NOOP_STREAM_SINK, broker)

    await sink.publishStarted(runRecord("running"))
    await sink.publishRunFinished(runRecord("succeeded"))

    const page = await broker.read({
      projectId: "project",
      streamId: AGENT_ACTIVITY_STREAM_ID,
    })
    expect(page.records.map((record) => record.payload)).toMatchObject([
      { status: "running", threadId: "thread-1" },
      { status: "succeeded", threadId: "thread-1" },
    ])
  })

  // Removal proof: publish activity for every run kind in withAgentActivityStream; the child's
  // start and finish reach the conversations' feed, which refreshes its readers' thread lists.
  test("keeps a sub-agent's run off the conversations' feed", async () => {
    const broker = new InMemoryBroker()
    const sink = withAgentActivityStream(NOOP_STREAM_SINK, broker)
    const child: SubagentRunRecord = {
      kind: "subagent",
      id: "child-1",
      projectId: "project",
      executionId: "execution-child-1",
      threadId: "thread-child-1",
      triggerMessageId: "task-child-1",
      parentRunId: "run-1",
      spawnKey: "west",
      spec: {
        model: { provider: "test", modelId: "test" },
        task: "Look.",
        toolNames: [],
        maxSteps: 4,
      },
      status: "running",
      attempt: 1,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    }

    // The turn's finish is written last, so the first record read proves the child's are not.
    await sink.publishStarted(child)
    await sink.publishRunFinished({ ...child, status: "succeeded", result: { text: "Done." } })
    await sink.publishRunFinished(runRecord("succeeded"))

    const page = await broker.read({ projectId: "project", streamId: AGENT_ACTIVITY_STREAM_ID })
    expect(page.records.map((record) => record.payload)).toMatchObject([
      { runId: "run-1", threadId: "thread-1" },
    ])
  })

  // Removal proof: publish nothing for a child in withAgentActivityStream; its parent's waits
  // hear nothing, and read its run only at their next re-check.
  test("tells a child's parent that it finished, even when transcript streaming is replaced", async () => {
    const broker = new InMemoryBroker()
    const sink = withAgentActivityStream(NOOP_STREAM_SINK, broker)
    const child: SubagentRunRecord = {
      kind: "subagent",
      id: "child-1",
      projectId: "project",
      executionId: "execution-child-1",
      threadId: "thread-child-1",
      triggerMessageId: "task-child-1",
      parentRunId: "run-1",
      spawnKey: "west",
      spec: {
        model: { provider: "test", modelId: "test" },
        task: "Look.",
        toolNames: [],
        maxSteps: 4,
      },
      status: "succeeded",
      finishReason: "awaiting_approval",
      attempt: 1,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    }

    await sink.publishStarted({ ...child, status: "running" })
    await sink.publishRunFinished(child)

    const page = await broker.read({
      projectId: "project",
      streamId: agentRunInboxStreamId("run-1"),
    })
    expect(page.records).toMatchObject([
      { name: "agent.child.finished", payload: { runId: "child-1", status: "succeeded" } },
    ])
  })

  test("waits for activity delivery before surfacing a custom sink failure", async () => {
    const broker = new InMemoryBroker()
    const sink = withAgentActivityStream(
      {
        ...NOOP_STREAM_SINK,
        async publishStarted() {
          throw new Error("custom sink failed")
        },
      },
      broker
    )

    await expect(sink.publishStarted(runRecord("running"))).rejects.toThrow("custom sink failed")
    const page = await broker.read({
      projectId: "project",
      streamId: AGENT_ACTIVITY_STREAM_ID,
    })
    expect(page.records).toHaveLength(1)
  })
})
