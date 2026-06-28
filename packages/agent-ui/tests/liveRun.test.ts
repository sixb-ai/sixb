import { describe, expect, test } from "bun:test"
import type { AgentRunStreamEvent } from "@sixb/client"
import { createLiveRunState, liveRunReducer } from "../src/liveRun"

const BASE_EVENT = {
  schemaVersion: 1,
  projectId: "project",
  runId: "run",
  threadId: "thread",
  agentId: "agent",
  attempt: 1,
  occurredAt: "2026-06-27T00:00:00.000Z",
} as const

function uiChunk(chunk: Record<string, unknown>): AgentRunStreamEvent {
  return {
    ...BASE_EVENT,
    type: "agent.ui.chunk",
    chunkIndex: 0,
    chunk,
  } as AgentRunStreamEvent
}

function reduceChunks(chunks: readonly Record<string, unknown>[]) {
  return chunks.reduce(
    (state, chunk) => liveRunReducer(state, { type: "event", event: uiChunk(chunk) }),
    createLiveRunState("run")
  )
}

describe("liveRunReducer", () => {
  test("keeps post-tool text ordered after the tool when the SDK reuses text ids", () => {
    const state = reduceChunks([
      { type: "start-step" },
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "Before tool." },
      { type: "text-end", id: "text" },
      { type: "tool-input-start", toolCallId: "call-1", toolName: "bash" },
      {
        type: "tool-input-available",
        toolCallId: "call-1",
        toolName: "bash",
        input: { command: "echo ok" },
      },
      {
        type: "tool-output-available",
        toolCallId: "call-1",
        output: { exitCode: 0, stdout: "ok" },
      },
      { type: "finish-step" },
      { type: "start-step" },
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "After tool." },
      { type: "text-end", id: "text" },
    ])

    expect(
      state.parts.map((part) =>
        part.kind === "tool" ? `tool:${part.toolName}` : `${part.kind}:${part.text}`
      )
    ).toEqual(["text:Before tool.", "tool:bash", "text:After tool."])
  })
})
