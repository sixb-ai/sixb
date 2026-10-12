import { describe, expect, test } from "bun:test"
import { createLiveRunState, type LiveRunState } from "../src/agent/live-run"
import {
  type ActiveTurnPresentation,
  type ActiveTurnSources,
  EXTENDED_WAITING_STATUS_MS,
  offersContinue,
  presentActiveTurn,
  selectActiveRunId,
  shouldShowExtendedWaitingStatus,
} from "../src/agent/run-presentation"
import type { AgentMessage, AgentRun } from "../src/agent/types"

type DiagnosticCode = AgentMessage["annotations"][number]["code"]

function run(input: Partial<AgentRun> & Pick<AgentRun, "id" | "status">): AgentRun {
  const { id, status, ...overrides } = input
  return {
    projectId: "project",
    threadId: "thread",
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
  test("delays the extended waiting status for queued runs only", () => {
    const queued = run({ id: "queued", status: "queued" })
    const createdAt = Date.parse(queued.createdAt)

    expect(
      shouldShowExtendedWaitingStatus(queued, createdAt + EXTENDED_WAITING_STATUS_MS - 1)
    ).toBe(false)
    expect(shouldShowExtendedWaitingStatus(queued, createdAt + EXTENDED_WAITING_STATUS_MS)).toBe(
      true
    )
    expect(
      shouldShowExtendedWaitingStatus(
        run({ id: "running", status: "running" }),
        createdAt + EXTENDED_WAITING_STATUS_MS
      )
    ).toBe(false)
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

const queued = run({ id: "r1", status: "queued" })
const running = run({ id: "r1", status: "running" })
const succeeded = run({ id: "r1", status: "succeeded" })
const failed = run({ id: "r1", status: "failed" })
const cancelled = run({ id: "r1", status: "cancelled" })
const interrupted = run({ id: "r1", status: "cancelled", finishReason: "interrupted" })
const timedOut = run({ id: "r1", status: "failed", finishReason: "timeout" })
const timedOutWithBudget = run({
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
const retried = run({ id: "r2", status: "succeeded" })
/** A run this browser sent, still running as far as durable state knows. */
const sentRunning = { activeRunId: "r1", pendingRun: running } as const
const partial = { parts: [{ kind: "text", text: "partial" }], partKeys: ["t1"] } as const

test.each<[string, Partial<ActiveTurnSources>, ActiveTurnPresentation]>([
  [
    "a queued run responds with the run needed for the extended waiting status",
    { activeRunId: "r1", pendingRun: queued, runs: [queued] },
    { kind: "responding", queuedRun: queued },
  ],
  [
    "running before the first token responds without the queued run",
    { activeRunId: "r1", streamRun: running, runs: [running] },
    { kind: "responding", queuedRun: null },
  ],
  [
    "an announced live stream responds without the queued run even while status lags",
    { activeRunId: "r1", runs: [queued], live: liveState({ runId: "r1", active: true }) },
    { kind: "responding", queuedRun: null },
  ],
  [
    "a terminal snapshot ends the responding state",
    { activeRunId: "r1", streamRun: succeeded, runs: [succeeded] },
    { kind: "idle" },
  ],
  [
    "a terminal live event ends the responding state",
    {
      activeRunId: "r1",
      runs: [running],
      live: liveState({ runId: "r1", finishStatus: "succeeded", ...partial }),
    },
    { kind: "idle" },
  ],
  [
    "the newest failed run without an assistant message surfaces as failed",
    { runs: [failed] },
    { kind: "failed", run: failed },
  ],
  [
    "a failed run that saved an answer is not a pre-stream failure",
    { runs: [failed], messages: [assistantMessage("r1")] },
    { kind: "idle" },
  ],
  [
    "an old failure stays hidden after a successful retry",
    { runs: [retried, failed], messages: [assistantMessage("r2")] },
    { kind: "idle" },
  ],
  [
    "a failure known only from the live event surfaces before history refetches",
    {
      activeRunId: "r1",
      streamRun: failed,
      live: liveState({ runId: "r1", finishStatus: "failed" }),
    },
    { kind: "failed", run: failed },
  ],
  [
    "a failed run with partial live content is not a pre-stream failure",
    {
      activeRunId: "r1",
      streamRun: failed,
      messages: [assistantMessage("r1")],
      live: liveState({ runId: "r1", finishStatus: "failed", ...partial }),
    },
    { kind: "idle" },
  ],
  [
    "a timeout with durable progress offers continuation with its configured duration",
    { runs: [timedOutWithBudget], messages: [assistantMessage("r1")] },
    { kind: "timeout", run: timedOutWithBudget, hasProgress: true, timeoutMs: 600_000 },
  ],
  [
    "a timeout without coherent progress offers retry",
    { runs: [timedOut] },
    { kind: "timeout", run: timedOut, hasProgress: false },
  ],
  [
    "a durable timeout waits for messages before deciding between continue and retry",
    { runs: [timedOut], messagesLoading: true },
    { kind: "idle" },
  ],
  [
    "a live timeout keeps streamed progress visible before durable state catches up",
    {
      ...sentRunning,
      live: liveState({ runId: "r1", finishStatus: "failed", finishReason: "timeout", ...partial }),
    },
    { kind: "timeout", run: running, hasProgress: true },
  ],
  [
    "a live timeout trusts a finalized message while the transcript refetch is pending",
    {
      ...sentRunning,
      live: liveState({
        runId: "r1",
        finalizedMessageId: "message-r1",
        finishStatus: "failed",
        finishReason: "timeout",
      }),
    },
    { kind: "timeout", run: running, hasProgress: true },
  ],
  [
    "a live timeout does not treat unsafe streaming fragments as resumable progress",
    {
      ...sentRunning,
      live: liveState({
        runId: "r1",
        finishStatus: "failed",
        finishReason: "timeout",
        parts: [
          { kind: "text", text: "   " },
          { kind: "reasoning", text: "\n", streaming: false },
          { kind: "reasoning", text: "unfinished", streaming: true },
          { kind: "tool", tool: { toolName: "bash", state: "input-streaming", inputText: "curl" } },
          { kind: "step-start" },
        ],
        partKeys: ["t1", "r1", "r2", "tool1", "step1"],
      }),
    },
    { kind: "timeout", run: running, hasProgress: false },
  ],
  [
    "a cancellation without content surfaces from history",
    { runs: [cancelled] },
    { kind: "cancelled" },
  ],
  [
    "a cancellation without content surfaces from the live event",
    { activeRunId: "r1", live: liveState({ runId: "r1", finishStatus: "cancelled" }) },
    { kind: "cancelled" },
  ],
  [
    "a cancellation that saved an answer is not marked",
    { runs: [cancelled], messages: [assistantMessage("r1")] },
    { kind: "idle" },
  ],
  [
    "an interrupted turn offers a retry from history",
    { runs: [interrupted] },
    { kind: "interrupted", run: interrupted, hasProgress: false },
  ],
  [
    // The live parts a dead worker streamed were never saved; they do not count as progress.
    "an interrupted turn offers a retry from the live event, whatever it streamed",
    {
      ...sentRunning,
      live: liveState({
        runId: "r1",
        finishStatus: "cancelled",
        finishReason: "interrupted",
        ...partial,
      }),
    },
    { kind: "interrupted", run: running, hasProgress: false },
  ],
  [
    "an interrupted turn stays hidden after a successful retry",
    { runs: [retried, interrupted], messages: [assistantMessage("r2")] },
    { kind: "idle" },
  ],
  [
    // Regression proof: compute hasProgress as false for interrupted turns; Continue is lost.
    "a turn interrupted by a stopping worker continues from its saved answer",
    { runs: [interrupted], messages: [assistantMessage("r1")] },
    { kind: "interrupted", run: interrupted, hasProgress: true },
  ],
  [
    "a turn interrupted by a stopping worker continues from its finalized live message",
    {
      ...sentRunning,
      live: liveState({
        runId: "r1",
        finalizedMessageId: "message-r1",
        finishStatus: "cancelled",
        finishReason: "interrupted",
      }),
    },
    { kind: "interrupted", run: running, hasProgress: true },
  ],
  [
    "a failed marker waits for the transcript to load",
    { runs: [failed], messagesLoading: true },
    { kind: "idle" },
  ],
  [
    "a cancelled marker waits for the transcript to load",
    { runs: [cancelled], messagesLoading: true },
    { kind: "idle" },
  ],
  [
    "an interrupted marker waits for the transcript to load",
    { runs: [interrupted], messagesLoading: true },
    { kind: "idle" },
  ],
])("presentActiveTurn: %s", (_name, overrides, expected) => {
  expect(presentActiveTurn(sources(overrides))).toEqual(expected)
})

test("offers to continue only the newest answer that stopped short, once nothing runs", () => {
  // Removal proof: drop the `idle`/`isRunning` checks or read every message's diagnostics in
  // offersContinue; a running thread or an older notice then offers Continue.
  const cutShort = (code: DiagnosticCode): AgentMessage => ({
    ...assistantMessage("cut-short"),
    annotations: [{ code, severity: "warning", scope: "run", message: "Developer copy." }],
  })
  const user: AgentMessage = { ...assistantMessage("next"), role: "user" }
  const idle = {
    presentation: { kind: "idle" } as const,
    isRunning: false,
    sandboxRecovery: false,
  }

  for (const code of ["output_limit_reached", "step_limit_reached"] as const) {
    expect(offersContinue({ ...idle, messages: [cutShort(code)] })).toBe(true)
  }
  expect(offersContinue({ ...idle, messages: [cutShort("output_limit_reached"), user] })).toBe(
    false
  )
  expect(
    offersContinue({ ...idle, isRunning: true, messages: [cutShort("output_limit_reached")] })
  ).toBe(false)
  expect(
    offersContinue({
      ...idle,
      presentation: { kind: "responding", queuedRun: null },
      messages: [cutShort("output_limit_reached")],
    })
  ).toBe(false)
  expect(
    offersContinue({ ...idle, sandboxRecovery: true, messages: [cutShort("step_limit_reached")] })
  ).toBe(false)
  const stopped = { kind: "interrupted" as const, run: run({ id: "stopped", status: "cancelled" }) }
  expect(
    offersContinue({
      ...idle,
      presentation: { ...stopped, hasProgress: true } as const,
      messages: [],
    })
  ).toBe(true)
  expect(
    offersContinue({
      ...idle,
      presentation: { ...stopped, hasProgress: false } as const,
      messages: [],
    })
  ).toBe(false)
})
