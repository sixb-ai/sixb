import type { AgentRunStreamEvent, ModelUiChunk } from "@sixb/client"
import { Markdown } from "@sixb/ui/components"
import { getCachedHighlight, highlightCode } from "@sixb/ui/lib/shiki"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { readThreadBackground } from "../src/agent/background/interpret"
import { Transcript } from "../src/agent/components/transcript"
import {
  conversationMessages,
  conversationTurn,
  normalizedParts,
  READ_ONLY_TURN,
} from "../src/agent/conversation"
import { delegationTurnEntry, readThreadDelegation } from "../src/agent/delegation/interpret"
import { createLiveRunState, type LiveRunState, liveRunReducer } from "../src/agent/live-run"
import type { AgentMessage, AgentRun } from "../src/agent/types"

const AT = "2026-11-14T15:00:00.000Z"

const BASE_EVENT = {
  schemaVersion: 1,
  projectId: "proj_bench",
  runId: "run_live",
  threadId: "thr_bench",
  attempt: 1,
  occurredAt: AT,
} as const

function chunkEvent(chunk: ModelUiChunk): AgentRunStreamEvent {
  return {
    ...BASE_EVENT,
    type: "agent.ui.chunk",
    chunkIndex: 0,
    chunk,
  } as AgentRunStreamEvent
}

function buildSavedHistory(turns = 15): {
  readonly messages: readonly AgentMessage[]
  readonly runs: readonly AgentRun[]
} {
  const messages: AgentMessage[] = []
  const runs: AgentRun[] = []

  for (let index = 1; index <= turns; index += 1) {
    const userMessageId = `msg_u_${index}`
    const runId = `run_${index}`
    messages.push({
      id: userMessageId,
      projectId: "proj_bench",
      threadId: "thr_bench",
      runId: null,
      role: "user",
      seq: index * 2 - 1,
      authorPrincipal: { type: "user", id: "usr_1" },
      parts: [{ type: "text", text: `Analyze Q${index} revenue and variance.` }],
      annotations: [],
      contentVersion: 1,
      createdAt: AT,
    })

    runs.push({
      id: runId,
      projectId: "proj_bench",
      kind: "conversation",
      threadId: "thr_bench",
      triggerMessageId: userMessageId,
      attempt: 0,
      streamId: `stream_${index}`,
      status: index === 4 ? "failed" : index === 9 ? "cancelled" : "succeeded",
      createdAt: AT,
    })

    messages.push({
      id: `msg_a_${index}`,
      projectId: "proj_bench",
      threadId: "thr_bench",
      runId,
      role: "assistant",
      seq: index * 2,
      parts: [
        { type: "reasoning", text: `Inspecting Q${index} rows.` },
        {
          type: "tool-call",
          toolCallId: `call_read_${index}`,
          toolName: "read",
          state: "output-available",
          input: { path: `reports/q${index}.md` },
          output: { content: "ok" },
        },
        { type: "step-start" },
        {
          type: "text",
          text: [
            `## Quarter ${index}`,
            "",
            "| Region | Revenue | Change |",
            "| :--- | ---: | ---: |",
            `| North | $${(1.2 * index).toFixed(2)}M | +4.1% |`,
            "",
            "```ts",
            `export const q${index} = ${1200 * index}`,
            "```",
          ].join("\n"),
        },
      ],
      annotations: [],
      contentVersion: 1,
      createdAt: AT,
    })
  }

  return { messages, runs }
}

function buildStreamChunks() {
  const started = { ...BASE_EVENT, type: "agent.run.started" } as AgentRunStreamEvent
  const events: Parameters<typeof liveRunReducer>[1][] = [
    { type: "event", event: started },
    { type: "event", event: chunkEvent({ type: "start-step" }) },
  ]

  for (let index = 0; index < 6; index += 1) {
    const toolCallId = `live_tool_${index}`
    events.push(
      {
        type: "event",
        event: chunkEvent({
          type: "tool-input-available",
          toolCallId,
          toolName: "read",
          input: { path: `f${index}.ts` },
        }),
      },
      {
        type: "event",
        event: chunkEvent({
          type: "tool-output-available",
          toolCallId,
          toolName: "read",
          output: { ok: true },
        }),
      }
    )
  }

  events.push({ type: "event", event: chunkEvent({ type: "start-step" }) })
  const markdown = [
    "# Summary\n\n",
    "```typescript\nexport const status = 1\n```\n\n",
    "| Check | Result |\n| :--- | ---: |\n| Saved rows | 0 |\n\n",
    "- [x] Bare code blocks\n- [x] Aligned tables\n\n",
    "```\nStream -> Transcript -> Markdown\n```\n",
  ].join("")

  for (let offset = 0; offset < markdown.length; offset += 8) {
    events.push({
      type: "event",
      event: chunkEvent({
        type: "text-delta",
        id: "t1",
        delta: markdown.slice(offset, offset + 8),
      }),
    })
  }
  return { events, markdown }
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

async function main() {
  const { messages: saved, runs } = buildSavedHistory(25)
  const { events, markdown } = buildStreamChunks()
  const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } })

  // 1. State fold + message/part/delegation normalization across a 50-message thread + stream
  const foldSamples: number[] = []
  let identityPreserved = true
  for (let sample = 0; sample < 15; sample += 1) {
    const start = Bun.nanoseconds()
    let live: LiveRunState = createLiveRunState("run_live")
    let previousSaved: unknown = null
    for (const action of events) {
      live = liveRunReducer(live, action)
      const merged = conversationMessages({
        messages: saved,
        runs,
        live,
        presentation: { kind: "responding", queuedRun: null },
      })
      if (previousSaved !== null && merged[0] !== previousSaved) identityPreserved = false
      previousSaved = merged[0]
      const latest = merged.at(-1)
      if (latest) normalizedParts(latest.parts)
      const turns = merged.flatMap((msg) => {
        const entry = delegationTurnEntry(msg)
        return entry ? [entry.turn] : []
      })
      readThreadDelegation(turns)
      readThreadBackground(merged)
    }
    foldSamples.push((Bun.nanoseconds() - start) / 1e6)
  }

  // 2. Markdown + Transcript SSR throughput
  await highlightCode("export const status = 1", "typescript")
  const ssrSamples: number[] = []
  for (let sample = 0; sample < 15; sample += 1) {
    const start = Bun.nanoseconds()
    renderToStaticMarkup(createElement(Markdown, null, markdown))
    ssrSamples.push((Bun.nanoseconds() - start) / 1e6)
  }

  const finalMerged = conversationMessages({
    messages: saved,
    runs,
    presentation: { kind: "idle" },
  })
  const turn = conversationTurn({
    ...READ_ONLY_TURN,
    presentation: { kind: "idle" },
    activeRunId: null,
  })
  const transcriptStart = Bun.nanoseconds()
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(Transcript, { threadId: "thr_bench", messages: finalMerged, turn })
    )
  )
  const transcriptSsrMs = (Bun.nanoseconds() - transcriptStart) / 1e6

  console.log(
    JSON.stringify(
      {
        savedMessages: saved.length,
        streamEvents: events.length,
        savedIdentityPreserved: identityPreserved,
        shikiCacheWarm: getCachedHighlight("export const status = 1", "typescript") !== null,
        streamFoldMedianMs: Number(median(foldSamples).toFixed(2)),
        markdownSsrMedianMs: Number(median(ssrSamples).toFixed(2)),
        transcript50MsgSsrMs: Number(transcriptSsrMs.toFixed(2)),
      },
      null,
      2
    )
  )
  queryClient.clear()
}

await main()
