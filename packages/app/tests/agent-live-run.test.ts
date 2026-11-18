import { describe, expect, test } from "bun:test"
import type { AgentRunStreamEvent } from "@sixb/client"
import { createLiveRunState, liveRunReducer } from "../src/agent/live-run"

const BASE_EVENT = {
  schemaVersion: 1,
  projectId: "project",
  runId: "run",
  threadId: "thread",
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
  test("rebuilds a turn opened late from its finished steps, then streams the current step", () => {
    // What the reader rebuilt from the live stream's oldest records is replaced.
    const partial = reduceChunks([{ type: "text-delta", id: "text", delta: "tail of an old step" }])
    let state = liveRunReducer(partial, {
      type: "event",
      event: event({
        type: "agent.ui.steps",
        throughChunkIndex: 9,
        chunks: [
          { type: "start-step" },
          { type: "text-delta", id: "text", delta: "Spawning researchers." },
          { type: "tool-input-start", toolCallId: "call-1", toolName: "spawn_agent" },
          {
            type: "tool-input-available",
            toolCallId: "call-1",
            toolName: "spawn_agent",
            input: { task: "research" },
          },
          {
            type: "tool-output-available",
            toolCallId: "call-1",
            toolName: "spawn_agent",
            output: { id: "child" },
          },
        ],
      }),
    })
    // The current step's start was dropped from the stream: its text, under the id the first step
    // used, is still a part of its own.
    state = liveRunReducer(state, {
      type: "event",
      event: uiChunk({ type: "text-delta", id: "text", delta: "Writing mockups." }),
    })

    expect(state.active).toBe(true)
    expect(
      state.parts.map((part) => (part.kind === "tool" ? part.tool.toolName : part.kind))
    ).toEqual(["text", "spawn_agent", "text"])
    expect(state.parts[0]).toEqual({ kind: "text", text: "Spawning researchers." })
    expect(state.parts[2]).toEqual({ kind: "text", text: "Writing mockups." })
  })

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

  // Reproduce: let liveRunReducer handle a retried start-step as any other; the first call's text
  // and tool card then stay above the answer.
  test("drops what a step's first call streamed when the step is asked again", () => {
    const state = reduceChunks([
      { type: "start-step" },
      { type: "text-delta", id: "text", delta: "Reading." },
      { type: "tool-output-available", toolCallId: "call-1", toolName: "read", output: "a" },
      { type: "start-step" },
      { type: "text-delta", id: "text", delta: "Half an ans" },
      { type: "tool-input-start", toolCallId: "call-2", toolName: "read" },
      { type: "start-step", retry: true },
      { type: "text-delta", id: "text", delta: "The answer." },
    ])

    expect(state.parts.map((part) => (part.kind === "text" ? part.text : part.kind))).toEqual([
      "Reading.",
      "tool",
      "The answer.",
    ])
  })

  test("materializes whitespace only after visible text has started", () => {
    const empty = reduceChunks([
      { type: "text-start", id: "empty" },
      { type: "text-delta", id: "empty", delta: " \n" },
      { type: "text-end", id: "empty" },
    ])
    expect(empty.parts).toEqual([])
    expect(empty.partKeys).toEqual([])

    const state = reduceChunks([
      { type: "text-delta", id: "text", delta: "Hello" },
      { type: "text-delta", id: "text", delta: " " },
      { type: "text-delta", id: "text", delta: "world" },
    ])
    expect(state.parts).toEqual([{ kind: "text", text: "Hello world" }])
  })

  // Removal proof: drop the reads from `applySteps`; the message then has no place in the turn.
  test("puts what a turn opened late read where it read it", () => {
    const steer = {
      id: "msg_steer",
      authorPrincipal: { type: "user" as const, id: "usr_mina" },
      parts: [{ type: "text" as const, text: "Use the Q3 numbers" }],
      createdAt: "2026-11-15T09:00:00.000Z",
    }
    const stale = { ...steer, id: "msg_stale" }
    const reconnected = liveRunReducer(createLiveRunState("run"), {
      type: "event",
      event: event({ type: "agent.inbox.read", messages: [stale] }),
    })

    let state = liveRunReducer(reconnected, {
      type: "event",
      event: event({
        type: "agent.ui.steps",
        throughChunkIndex: 5,
        chunks: [
          { type: "start-step" },
          { type: "text-delta", id: "a", delta: "Q2 shows a dip." },
          { type: "start-step" },
          { type: "text-delta", id: "a", delta: "With Q3" },
        ],
        reads: [{ at: 3, messages: [steer] }],
      }),
    })
    state = liveRunReducer(state, {
      type: "event",
      event: uiChunk({ type: "text-delta", id: "a", delta: "Done." }),
    })

    expect(state.inboxReads).toEqual([{ at: 1, messages: [steer] }])
    expect(state.parts).toEqual([
      { kind: "text", text: "Q2 shows a dip." },
      { kind: "text", text: "With Q3" },
      { kind: "text", text: "Done." },
    ])
  })

  // Removal proof: drop the `agent.inbox.read` case from the reducer; nothing marks where the turn
  // read the message.
  test("keeps where the turn read a message, through a step asked again", () => {
    const steer = {
      id: "msg_steer",
      authorPrincipal: { type: "user" as const, id: "usr_mina" },
      parts: [{ type: "text" as const, text: "Use the Q3 numbers" }],
      createdAt: "2026-11-15T09:00:00.000Z",
    }
    let state = reduceChunks([
      { type: "start-step" },
      { type: "text-delta", id: "a", delta: "Q2 shows a dip." },
      { type: "start-step" },
    ])
    state = liveRunReducer(state, {
      type: "event",
      event: event({ type: "agent.inbox.read", messages: [steer] }),
    })
    for (const chunk of [
      { type: "text-delta", id: "b", delta: "First try" },
      { type: "start-step", retry: true },
      { type: "text-delta", id: "b", delta: "With Q3" },
    ]) {
      state = liveRunReducer(state, { type: "event", event: uiChunk(chunk) })
    }

    expect(state.inboxReads).toEqual([{ at: 1, messages: [steer] }])
    expect(state.parts).toEqual([
      { kind: "text", text: "Q2 shows a dip." },
      { kind: "text", text: "With Q3" },
    ])
  })

  test("marks the run active on start", () => {
    const state = liveRunReducer(createLiveRunState(null), {
      type: "event",
      event: event({ type: "agent.run.started", runId: "run" }),
    })
    expect(state.runId).toBe("run")
    expect(state.active).toBe(true)
  })

  test("tracks compaction until it completes or fails", () => {
    const compacting = liveRunReducer(createLiveRunState("run"), {
      type: "event",
      event: event({
        type: "agent.compaction.started",
        reason: "threshold",
        estimatedInputTokensBefore: 95_000,
      }),
    })
    expect(compacting.active).toBe(true)
    expect(compacting.compacting).toBe(true)

    const completed = liveRunReducer(compacting, {
      type: "event",
      event: event({
        type: "agent.compaction.completed",
        reason: "threshold",
        checkpointId: "agt_ctx_run",
        estimatedInputTokensBefore: 95_000,
        estimatedInputTokensAfter: 30_000,
      }),
    })
    expect(completed.compacting).toBe(false)

    const failed = liveRunReducer(compacting, {
      type: "event",
      event: event({
        type: "agent.compaction.failed",
        reason: "threshold",
        errorCode: "summary_failed",
      }),
    })
    expect(failed.compacting).toBe(false)
  })

  // Reproduce: leave `contextFull` false on `agent.compaction.started`; a turn the provider
  // refused condenses with the ordinary marker.
  test("a compaction after the provider refused a request is the context being full", () => {
    const full = liveRunReducer(createLiveRunState("run"), {
      type: "event",
      event: event({
        type: "agent.compaction.started",
        reason: "overflow",
        estimatedInputTokensBefore: 131_000,
      }),
    })
    expect(full).toMatchObject({ compacting: true, contextFull: true })

    const completed = liveRunReducer(full, {
      type: "event",
      event: event({
        type: "agent.compaction.completed",
        reason: "overflow",
        checkpointId: "agt_ctx_run",
        estimatedInputTokensBefore: 131_000,
        estimatedInputTokensAfter: 41_000,
      }),
    })
    expect(completed).toMatchObject({ compacting: false, contextFull: false })
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
