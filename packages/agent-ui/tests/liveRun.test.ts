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

function event(partial: Record<string, unknown>): AgentRunStreamEvent {
  return { ...BASE_EVENT, ...partial } as AgentRunStreamEvent
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
      state.parts.map((part) => {
        if (part.kind === "tool") return `tool:${part.tool.toolName}`
        if (part.kind === "text" || part.kind === "reasoning") return `${part.kind}:${part.text}`
        return part.kind
      })
    ).toEqual(["text:Before tool.", "tool:bash", "text:After tool."])
  })

  test("does not materialize empty text lifecycle chunks or whitespace-only spans", () => {
    let state = createLiveRunState("run")
    for (const chunk of [
      { type: "text-start", id: "empty" },
      { type: "text-delta", id: "empty", delta: " \n" },
      { type: "text-end", id: "empty" },
    ]) {
      state = liveRunReducer(state, {
        type: "event",
        event: uiChunk(chunk),
      })
    }

    expect(state.parts).toEqual([])
    expect(state.partKeys).toEqual([])
  })

  test("keeps whitespace deltas after visible text has started", () => {
    const state = reduceChunks([
      { type: "text-delta", id: "text", delta: "Hello" },
      { type: "text-delta", id: "text", delta: " " },
      { type: "text-delta", id: "text", delta: "world" },
    ])

    expect(state.parts).toEqual([{ kind: "text", text: "Hello world" }])
  })

  test("marks the run active on start", () => {
    const state = liveRunReducer(createLiveRunState(null), {
      type: "event",
      event: event({ type: "agent.run.started", runId: "run" }),
    })
    expect(state.runId).toBe("run")
    expect(state.active).toBe(true)
  })

  test("reasoning streams until it ends", () => {
    const streaming = reduceChunks([
      { type: "reasoning-start", id: "r" },
      { type: "reasoning-delta", id: "r", delta: "thin" },
      { type: "reasoning-delta", id: "r", delta: "king" },
    ])
    expect(streaming.parts).toEqual([{ kind: "reasoning", text: "thinking", streaming: true }])

    const done = reduceChunks([
      { type: "reasoning-start", id: "r" },
      { type: "reasoning-delta", id: "r", delta: "done" },
      { type: "reasoning-end", id: "r" },
    ])
    expect(done.parts).toEqual([{ kind: "reasoning", text: "done", streaming: false }])
  })

  test("advances a tool through the input/output state machine", () => {
    const state = reduceChunks([
      { type: "tool-input-start", toolCallId: "c1", toolName: "bash" },
      { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '{"command":' },
      { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '"ls"}' },
      { type: "tool-input-available", toolCallId: "c1", input: { command: "ls" } },
      { type: "tool-output-available", toolCallId: "c1", output: { exitCode: 0 } },
    ])
    expect(state.parts).toEqual([
      {
        kind: "tool",
        tool: {
          toolName: "bash",
          state: "output-available",
          inputText: '{"command":"ls"}',
          input: { command: "ls" },
          output: { exitCode: 0 },
        },
      },
    ])
  })

  test("records tool output errors", () => {
    const state = reduceChunks([
      { type: "tool-input-start", toolCallId: "c1", toolName: "bash" },
      { type: "tool-output-error", toolCallId: "c1", errorText: "boom" },
    ])
    expect(state.parts).toEqual([
      {
        kind: "tool",
        tool: { toolName: "bash", state: "output-error", inputText: "", errorText: "boom" },
      },
    ])
  })

  test("records the finalized message id", () => {
    const state = liveRunReducer(createLiveRunState("run"), {
      type: "event",
      event: event({ type: "agent.message.finalized", messageId: "m1" }),
    })
    expect(state.finalizedMessageId).toBe("m1")
  })

  test("captures a failed run's terminal status and error", () => {
    const failure = {
      code: "internal.unexpected" as const,
      message: "nope",
      retryable: false,
      at: "2026-01-02T03:04:05.000Z",
      details: { agentId: "assistant", runId: "run" },
    }
    const state = liveRunReducer(createLiveRunState("run"), {
      type: "event",
      event: event({
        type: "agent.run.finished",
        status: "failed",
        finishReason: "timeout",
        error: failure,
      }),
    })
    expect(state.active).toBe(false)
    expect(state.finishStatus).toBe("failed")
    expect(state.finishReason).toBe("timeout")
    expect(state.finishError).toEqual(failure)
  })

  test("surfaces stream errors from both the action and error chunks", () => {
    const fromAction = liveRunReducer(createLiveRunState("run"), {
      type: "stream-error",
      message: "socket died",
    })
    expect(fromAction.streamError).toBe("socket died")

    const fromChunk = reduceChunks([{ type: "error", errorText: "stream boom" }])
    expect(fromChunk.streamError).toBe("stream boom")
  })

  test("reset clears accumulated parts and repoints the run", () => {
    const dirty = reduceChunks([
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "hi" },
    ])
    const state = liveRunReducer(dirty, { type: "reset", runId: "run-2" })
    expect(state.parts).toEqual([])
    expect(state.partKeys).toEqual([])
    expect(state.runId).toBe("run-2")
  })
})
