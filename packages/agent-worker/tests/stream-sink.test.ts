import { describe, expect, test } from "bun:test"
import { InMemoryBroker } from "@sixb/core"
import { AGENT_ACTIVITY_STREAM_ID } from "@sixb/core/agents/streams"
import type { AgentRunRecord } from "@sixb/core/storage"
import { NOOP_STREAM_SINK, withAgentActivityStream } from "../src/stream-sink"

function runRecord(status: AgentRunRecord["status"]): AgentRunRecord {
  return {
    id: "run-1",
    projectId: "project",
    executionId: "execution-1",
    threadId: "thread-1",
    agentId: "agent-1",
    triggerMessageId: "message-1",
    requesterGroupIds: [],
    requesterAuthorizationGroupIds: [],
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
