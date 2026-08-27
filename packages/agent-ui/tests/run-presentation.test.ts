import { describe, expect, test } from "bun:test"
import { createLiveRunState, type LiveRunState } from "../src/liveRun"
import {
  type ActiveTurnSources,
  DELAYED_WAITING_COPY_MS,
  findPreStreamFailedRun,
  presentActiveTurn,
  selectActiveRunId,
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
    requestedBy: { type: "user", id: "user" },
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

  test("selects the active run from pending send, thread claim, then history", () => {
    const queued = run({ id: "queued", status: "queued" })
    const done = run({ id: "done", status: "succeeded" })

    expect(
      selectActiveRunId({ pendingRun: queued, threadActiveRunId: "claimed", latestRun: done })
    ).toBe("queued")
    expect(
      selectActiveRunId({ pendingRun: null, threadActiveRunId: "claimed", latestRun: done })
    ).toBe("claimed")
    expect(
      selectActiveRunId({ pendingRun: null, threadActiveRunId: null, latestRun: queued })
    ).toBe("queued")
    expect(selectActiveRunId({ pendingRun: null, threadActiveRunId: null, latestRun: done })).toBe(
      null
    )
  })
})

function sources(overrides: Partial<ActiveTurnSources> = {}): ActiveTurnSources {
  return {
    activeRunId: null,
    pendingRun: null,
    streamRun: null,
    live: createLiveRunState(),
    runs: [],
    messages: [],
    messagesLoading: false,
    ...overrides,
  }
}

function liveState(overrides: Partial<LiveRunState>): LiveRunState {
  return { ...createLiveRunState(overrides.runId ?? null), ...overrides }
}

describe("presentActiveTurn", () => {
  test("a queued run responds with the queued run for the delayed copy", () => {
    const queued = run({ id: "r1", status: "queued" })
    const presentation = presentActiveTurn(
      sources({ activeRunId: "r1", pendingRun: queued, runs: [queued] })
    )
    expect(presentation).toEqual({ kind: "responding", queuedRun: queued })
  })

  test("running before the first token responds without the queued run", () => {
    const running = run({ id: "r1", status: "running" })
    const presentation = presentActiveTurn(
      sources({ activeRunId: "r1", streamRun: running, runs: [running] })
    )
    expect(presentation).toEqual({ kind: "responding", queuedRun: null })
  })

  test("an announced live stream responds without the queued run even while status lags", () => {
    const queued = run({ id: "r1", status: "queued" })
    const presentation = presentActiveTurn(
      sources({
        activeRunId: "r1",
        runs: [queued],
        live: liveState({ runId: "r1", active: true }),
      })
    )
    expect(presentation).toEqual({ kind: "responding", queuedRun: null })
  })

  test("a terminal snapshot ends the responding state", () => {
    const succeeded = run({ id: "r1", status: "succeeded" })
    const presentation = presentActiveTurn(
      sources({ activeRunId: "r1", streamRun: succeeded, runs: [succeeded] })
    )
    expect(presentation).toEqual({ kind: "idle" })
  })

  test("a terminal live event ends the responding state", () => {
    const running = run({ id: "r1", status: "running" })
    const presentation = presentActiveTurn(
      sources({
        activeRunId: "r1",
        runs: [running],
        live: liveState({
          runId: "r1",
          finishStatus: "succeeded",
          parts: [{ kind: "text", text: "hi" }],
          partKeys: ["t1"],
        }),
      })
    )
    expect(presentation).toEqual({ kind: "idle" })
  })

  test("the newest failed run without an assistant message surfaces as failed", () => {
    const failed = run({ id: "r1", status: "failed" })
    const presentation = presentActiveTurn(sources({ runs: [failed] }))
    expect(presentation).toEqual({ kind: "failed", run: failed })
  })

  test("a timeout with durable progress offers continuation with its configured duration", () => {
    const timedOut = run({
      id: "r1",
      status: "failed",
      finishReason: "timeout",
      error: {
        code: "agent.execution_failed",
        message: "Agent execution failed.",
        retryable: false,
        at: "2026-07-12T10:10:00.000Z",
        details: { timeoutMs: "600000" },
      },
    })
    const presentation = presentActiveTurn(
      sources({ runs: [timedOut], messages: [assistantMessage(timedOut.id)] })
    )

    expect(presentation).toEqual({
      kind: "timeout",
      run: timedOut,
      hasProgress: true,
      timeoutMs: 600_000,
    })
  })

  test("a timeout without coherent progress offers retry", () => {
    const timedOut = run({ id: "r1", status: "failed", finishReason: "timeout" })

    expect(presentActiveTurn(sources({ runs: [timedOut] }))).toEqual({
      kind: "timeout",
      run: timedOut,
      hasProgress: false,
    })
  })

  test("a durable timeout waits for messages before deciding between continue and retry", () => {
    const timedOut = run({ id: "r1", status: "failed", finishReason: "timeout" })

    expect(presentActiveTurn(sources({ runs: [timedOut], messagesLoading: true }))).toEqual({
      kind: "idle",
    })
  })

  test("a live timeout keeps streamed progress visible before durable state catches up", () => {
    const running = run({ id: "r1", status: "running" })
    const presentation = presentActiveTurn(
      sources({
        activeRunId: running.id,
        pendingRun: running,
        live: liveState({
          runId: running.id,
          finishStatus: "failed",
          finishReason: "timeout",
          parts: [{ kind: "text", text: "partial" }],
          partKeys: ["t1"],
        }),
      })
    )

    expect(presentation).toEqual({ kind: "timeout", run: running, hasProgress: true })
  })

  test("a live timeout trusts a finalized message while the transcript refetch is pending", () => {
    const running = run({ id: "r1", status: "running" })
    const presentation = presentActiveTurn(
      sources({
        activeRunId: running.id,
        pendingRun: running,
        live: liveState({
          runId: running.id,
          finalizedMessageId: "message-r1",
          finishStatus: "failed",
          finishReason: "timeout",
        }),
      })
    )

    expect(presentation).toEqual({ kind: "timeout", run: running, hasProgress: true })
  })

  test("a live timeout does not treat unsafe streaming fragments as resumable progress", () => {
    const running = run({ id: "r1", status: "running" })
    const presentation = presentActiveTurn(
      sources({
        activeRunId: running.id,
        pendingRun: running,
        live: liveState({
          runId: running.id,
          finishStatus: "failed",
          finishReason: "timeout",
          parts: [
            { kind: "text", text: "   " },
            { kind: "reasoning", text: "\n", streaming: false },
            { kind: "reasoning", text: "unfinished", streaming: true },
            {
              kind: "tool",
              tool: { toolName: "bash", state: "input-streaming", inputText: "curl" },
            },
            { kind: "step-start" },
          ],
          partKeys: ["t1", "r1", "r2", "tool1", "step1"],
        }),
      })
    )

    expect(presentation).toEqual({ kind: "timeout", run: running, hasProgress: false })
  })

  test("an old failure stays hidden after a successful retry", () => {
    const failed = run({ id: "r1", status: "failed" })
    const retried = run({ id: "r2", status: "succeeded" })
    const presentation = presentActiveTurn(
      sources({ runs: [retried, failed], messages: [assistantMessage("r2")] })
    )
    expect(presentation).toEqual({ kind: "idle" })
  })

  test("a failure known only from the live event surfaces before history refetches", () => {
    const failed = run({ id: "r1", status: "failed" })
    const presentation = presentActiveTurn(
      sources({
        activeRunId: "r1",
        streamRun: failed,
        live: liveState({ runId: "r1", finishStatus: "failed" }),
      })
    )
    expect(presentation).toEqual({ kind: "failed", run: failed })
  })

  test("a cancellation without content surfaces from history or from the live event", () => {
    const cancelled = run({ id: "r1", status: "cancelled" })
    expect(presentActiveTurn(sources({ runs: [cancelled] }))).toEqual({ kind: "cancelled" })
    expect(
      presentActiveTurn(
        sources({ activeRunId: "r1", live: liveState({ runId: "r1", finishStatus: "cancelled" }) })
      )
    ).toEqual({ kind: "cancelled" })
    expect(
      presentActiveTurn(sources({ runs: [cancelled], messages: [assistantMessage("r1")] }))
    ).toEqual({ kind: "idle" })
  })

  test("terminal markers wait for the transcript to load", () => {
    const failed = run({ id: "r1", status: "failed" })
    const cancelled = run({ id: "r2", status: "cancelled" })
    expect(presentActiveTurn(sources({ runs: [failed], messagesLoading: true }))).toEqual({
      kind: "idle",
    })
    expect(presentActiveTurn(sources({ runs: [cancelled], messagesLoading: true }))).toEqual({
      kind: "idle",
    })
  })

  test("a failed run with partial live content is not a pre-stream failure", () => {
    const failed = run({ id: "r1", status: "failed" })
    const presentation = presentActiveTurn(
      sources({
        activeRunId: "r1",
        streamRun: failed,
        messages: [assistantMessage("r1")],
        live: liveState({
          runId: "r1",
          finishStatus: "failed",
          parts: [{ kind: "text", text: "partial" }],
          partKeys: ["t1"],
        }),
      })
    )
    expect(presentation).toEqual({ kind: "idle" })
  })
})
