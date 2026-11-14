import { describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { defineAgentToolView } from "../src"
import { ArtifactPanelRoot } from "../src/agent/artifact-panel"
import { Transcript } from "../src/agent/components/transcript"
import {
  conversationMessages,
  conversationTurn,
  normalizedParts,
  READ_ONLY_TURN,
} from "../src/agent/conversation"
import { delegationTurnEntry } from "../src/agent/delegation/interpret"
import { createLiveRunState, type LiveRunState, liveRunReducer } from "../src/agent/live-run"
import { AgentToolViewsProvider } from "../src/agent/tool-views/registry"
import type { AgentMessage, AgentRun } from "../src/agent/types"
import { useOpenArtifactAddress } from "../src/artifacts/references/references"
import { installDom } from "./helpers/dom"

installDom([
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Event",
  "EventTarget",
  "MouseEvent",
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

const at = "2026-11-14T12:00:00.000Z"

function savedTurn(index: number, status: AgentRun["status"] = "succeeded") {
  const userMessage: AgentMessage = {
    id: `msg_u_${index}`,
    projectId: "proj",
    threadId: "thr_1",
    runId: null,
    role: "user",
    seq: index * 2 - 1,
    parts: [{ type: "text", text: `Prompt ${index}` }],
    annotations: [],
    contentVersion: 1,
    createdAt: at,
  }
  const assistantMessage: AgentMessage = {
    id: `msg_a_${index}`,
    projectId: "proj",
    threadId: "thr_1",
    runId: `run_${index}`,
    role: "assistant",
    seq: index * 2,
    parts: [
      {
        type: "tool-call",
        toolCallId: `call_${index}`,
        toolName: "saved_probe",
        state: "output-available",
        input: { index },
        output: { ok: true },
      },
      { type: "text", text: `Completed reply ${index} with **markdown**.` },
    ],
    annotations:
      index === 3 ? [{ code: "output_limit_reached", severity: "warning", message: "Cut" }] : [],
    contentVersion: 1,
    createdAt: at,
  }
  const run: AgentRun = {
    id: `run_${index}`,
    projectId: "proj",
    kind: "conversation",
    threadId: "thr_1",
    triggerMessageId: userMessage.id,
    attempt: 0,
    streamId: `stream_${index}`,
    status,
    createdAt: at,
  }
  return { userMessage, assistantMessage, run }
}

describe("agent chat re-render stability", () => {
  test("completed and unfinished saved rows never re-render while a live reply streams", () => {
    // Removal proof: pass `after={<UnfinishedMarker ... />}` from Transcript instead of rendering
    // it inside `TranscriptMessage`, or pass raw `onContinue` without `stableOnContinue`; the
    // saved probe renders on every streaming chunk instead of staying at 3.
    const t1 = savedTurn(1, "failed")
    const t2 = savedTurn(2, "cancelled")
    const t3 = savedTurn(3, "succeeded")
    const saved = [
      t1.userMessage,
      t1.assistantMessage,
      t2.userMessage,
      t2.assistantMessage,
      t3.userMessage,
      t3.assistantMessage,
    ]
    const runs = [t1.run, t2.run, t3.run]

    let savedRenders = 0
    let liveToolRenders = 0

    function SavedProbe() {
      savedRenders += 1
      return <div>saved</div>
    }

    function LiveProbe() {
      liveToolRenders += 1
      return <div>live</div>
    }

    const views = [
      defineAgentToolView("saved_probe", { placement: "answer" }).render(SavedProbe),
      defineAgentToolView("live_probe", { placement: "answer" }).render(LiveProbe),
    ]

    const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
    const ui = (live?: LiveRunState) => {
      const responding = Boolean(live?.active)
      const presentation = responding
        ? ({ kind: "responding", queuedRun: null } as const)
        : ({ kind: "idle" } as const)
      return (
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <AgentToolViewsProvider views={views}>
              <Transcript
                threadId="thr_1"
                messages={conversationMessages({ messages: saved, runs, live, presentation })}
                turn={conversationTurn({
                  ...READ_ONLY_TURN,
                  canContinue: !responding,
                  canStop: responding,
                  presentation,
                  activeRunId: responding ? "run_live" : null,
                })}
                onContinue={() => {}}
              />
            </AgentToolViewsProvider>
          </MemoryRouter>
        </QueryClientProvider>
      )
    }

    const view = render(ui())
    expect(savedRenders).toBe(3)
    expect(liveToolRenders).toBe(0)

    let live = createLiveRunState("run_live")
    live = liveRunReducer(live, {
      type: "event",
      event: { type: "agent.run.started", runId: "run_live" },
    })
    live = liveRunReducer(live, {
      type: "event",
      event: { type: "agent.ui.chunk", chunk: { type: "start-step" } },
    })
    live = liveRunReducer(live, {
      type: "event",
      event: {
        type: "agent.ui.chunk",
        chunk: {
          type: "tool-input-available",
          toolCallId: "c_live",
          toolName: "live_probe",
          input: {},
        },
      },
    })
    live = liveRunReducer(live, {
      type: "event",
      event: {
        type: "agent.ui.chunk",
        chunk: { type: "tool-output-available", toolCallId: "c_live", output: { ready: true } },
      },
    })
    view.rerender(ui(live))
    expect(savedRenders).toBe(3)
    expect(liveToolRenders).toBe(1)

    // Stream 20 text chunks in step 2: neither saved rows nor the settled live tool view re-render.
    // Removal proof: drop the WeakMap in `liveParts` / `normalizedParts` or `memo` on
    // `AnswerToolViews`; `liveToolRenders` climbs to 21.
    live = liveRunReducer(live, {
      type: "event",
      event: { type: "agent.ui.chunk", chunk: { type: "start-step" } },
    })
    for (let index = 0; index < 20; index += 1) {
      live = liveRunReducer(live, {
        type: "event",
        event: {
          type: "agent.ui.chunk",
          chunk: { type: "text-delta", id: "t_live", delta: `chunk ${index} ` },
        },
      })
      view.rerender(ui(live))
    }

    expect(savedRenders).toBe(3)
    expect(liveToolRenders).toBe(1)
    queryClient.clear()
  })

  test("switching open artifacts does not re-render reference consumers in the transcript", () => {
    // Removal proof: include `routeTarget` in `ArtifactPanelRoot`'s `show` / `open` useCallback
    // deps; `ArtifactReferencesProvider` emits a new context value and `consumerRenders` climbs on
    // every target switch.
    const t1 = savedTurn(1)
    const saved = [t1.userMessage, t1.assistantMessage]
    let consumerRenders = 0

    function SavedReferenceProbe() {
      useOpenArtifactAddress()
      consumerRenders += 1
      return <div>consumer</div>
    }

    const views = [
      defineAgentToolView("saved_probe", { placement: "answer" }).render(SavedReferenceProbe),
    ]

    const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
    const messages = conversationMessages({ messages: saved, presentation: { kind: "idle" } })
    const turn = conversationTurn({
      ...READ_ONLY_TURN,
      presentation: { kind: "idle" },
      activeRunId: null,
    })

    const ui = (artifactId: string | null) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <AgentToolViewsProvider views={views}>
            <ArtifactPanelRoot
              scopeKey="thr_1"
              routeTarget={artifactId ? { type: "artifact", artifactId } : null}
              onRouteTargetChange={() => {}}
            >
              <Transcript threadId="thr_1" messages={messages} turn={turn} />
            </ArtifactPanelRoot>
          </AgentToolViewsProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )

    const view = render(ui(null))
    expect(consumerRenders).toBe(1)

    for (const target of ["art_0123456789", "art_9876543210", null, "art_0123456789", null]) {
      view.rerender(ui(target))
    }

    expect(consumerRenders).toBe(1)
    queryClient.clear()
  })

  test("preserves part and delegation identity across live chunks and concurrent views", () => {
    const t1 = savedTurn(1)
    const saved = [t1.userMessage, t1.assistantMessage]

    // Owner and observer views reading the same cached AgentMessage never thrash each other.
    const ownerFirst = conversationMessages({
      messages: saved,
      observed: false,
      presentation: { kind: "idle" },
    })
    const observerView = conversationMessages({
      messages: saved,
      observed: true,
      presentation: { kind: "idle" },
    })
    const ownerSecond = conversationMessages({
      messages: saved,
      observed: false,
      presentation: { kind: "idle" },
    })
    expect(ownerSecond[1]).toBe(ownerFirst[1])
    expect(observerView[1]).not.toBe(ownerFirst[1])
    expect(delegationTurnEntry(ownerFirst[1]!)).toBe(delegationTurnEntry(ownerSecond[1]!))

    // Untouched tool and reasoning parts keep NormalizedPart identity across later text chunks.
    let live = createLiveRunState("run_live")
    live = liveRunReducer(live, {
      type: "event",
      event: { type: "agent.run.started", runId: "run_live" },
    })
    live = liveRunReducer(live, {
      type: "event",
      event: {
        type: "agent.ui.chunk",
        chunk: { type: "reasoning-delta", id: "r1", delta: "Checking schema" },
      },
    })
    live = liveRunReducer(live, {
      type: "event",
      event: { type: "agent.ui.chunk", chunk: { type: "reasoning-end", id: "r1" } },
    })
    live = liveRunReducer(live, {
      type: "event",
      event: {
        type: "agent.ui.chunk",
        chunk: {
          type: "tool-input-available",
          toolCallId: "c1",
          toolName: "read",
          input: { path: "a.ts" },
        },
      },
    })
    live = liveRunReducer(live, {
      type: "event",
      event: {
        type: "agent.ui.chunk",
        chunk: { type: "tool-output-available", toolCallId: "c1", output: { content: "x" } },
      },
    })

    const beforeText = conversationMessages({
      messages: [],
      live,
      presentation: { kind: "responding", queuedRun: null },
    })[0]!
    const normalizedBefore = normalizedParts(beforeText.parts)

    live = liveRunReducer(live, {
      type: "event",
      event: { type: "agent.ui.chunk", chunk: { type: "start-step" } },
    })
    live = liveRunReducer(live, {
      type: "event",
      event: { type: "agent.ui.chunk", chunk: { type: "text-delta", id: "t1", delta: "Answer" } },
    })

    const afterText = conversationMessages({
      messages: [],
      live,
      presentation: { kind: "responding", queuedRun: null },
    })[0]!
    const normalizedAfter = normalizedParts(afterText.parts)

    expect(afterText.parts[0]).toBe(beforeText.parts[0])
    expect(afterText.parts[1]).toBe(beforeText.parts[1])
    expect(normalizedAfter[0]).toBe(normalizedBefore[0])
    expect(normalizedAfter[1]).toBe(normalizedBefore[1])
  })
})
