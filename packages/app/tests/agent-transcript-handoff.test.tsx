import { expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { Transcript } from "../src/agent/components/transcript"
import {
  type ConversationMessagesInput,
  conversationMessages,
  conversationTurn,
  READ_ONLY_TURN,
} from "../src/agent/conversation"
import { createLiveRunState } from "../src/agent/live-run"
import type { AgentMessage } from "../src/agent/types"
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

const at = "2026-10-27T09:00:00.000Z"

const question: AgentMessage = {
  id: "msg_question",
  projectId: "proj",
  threadId: "thr_1",
  runId: null,
  role: "user",
  seq: 1,
  parts: [{ type: "text", text: "Which deals slipped?" }],
  annotations: [],
  contentVersion: 1,
  createdAt: at,
}

const answer: AgentMessage = {
  ...question,
  id: "msg_answer",
  runId: "run_1",
  role: "assistant",
  seq: 2,
  parts: [{ type: "text", text: "Three deals slipped." }],
}

test("the transcript keeps a turn's rows when their saved copies replace them", () => {
  // Removal proof: key TranscriptMessage by `message.id ?? message.key`, or drop the `sentKeys`
  // lookup in conversationMessages; the rows are mounted again.
  const queryClient = new QueryClient()
  const sentKeys = new Map([[question.id, "sent:1"]])
  const ui = (input: Omit<ConversationMessagesInput, "presentation">) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Transcript
          threadId="thr_1"
          anchorCurrentTurn
          messages={conversationMessages({ ...input, presentation: { kind: "idle" }, sentKeys })}
          turn={conversationTurn({
            ...READ_ONLY_TURN,
            presentation: { kind: "idle" },
            activeRunId: null,
          })}
        />
      </MemoryRouter>
    </QueryClientProvider>
  )
  const row = (text: string) => view.getByText(text).closest("[data-message-id]")

  // Sent, and its reply streaming.
  const view = render(
    ui({
      messages: [],
      pending: {
        key: "sent:1",
        threadId: "thr_1",
        text: "Which deals slipped?",
        attachments: [],
        context: [],
        messageId: question.id,
      },
      live: {
        ...createLiveRunState("run_1"),
        active: true,
        parts: [{ kind: "text", text: "Three deals slipped." }],
        partKeys: ["text#1#t"],
      },
    })
  )
  const sent = row("Which deals slipped?")
  const streamed = row("Three deals slipped.")
  expect(sent?.getAttribute("data-scroll-anchor")).toBe("true")

  // Both saved and read back.
  view.rerender(ui({ messages: [question, answer] }))

  expect(row("Which deals slipped?")).toBe(sent)
  expect(row("Three deals slipped.")).toBe(streamed)
  expect(view.getAllByText("Three deals slipped.")).toHaveLength(1)
  queryClient.clear()
})

test("a continued answer anchors the reply that continues it, not the question", () => {
  // Removal proof: return the last user message's key from currentTurnAnchor whatever follows it;
  // the question anchors instead.
  const queryClient = new QueryClient()
  const continuation: AgentMessage = {
    ...question,
    id: "msg_continue",
    seq: 3,
    parts: [{ type: "continuation" }],
  }
  const ui = (input: Pick<ConversationMessagesInput, "live">) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Transcript
          threadId="thr_1"
          anchorCurrentTurn
          messages={conversationMessages({
            messages: [question, answer, continuation],
            presentation: { kind: "responding", queuedRun: null },
            ...input,
          })}
          turn={conversationTurn({
            ...READ_ONLY_TURN,
            presentation: { kind: "responding", queuedRun: null },
            activeRunId: "run_2",
          })}
        />
      </MemoryRouter>
    </QueryClientProvider>
  )
  const anchors = () =>
    Array.from(document.querySelectorAll('[data-scroll-anchor="true"]')).map((row) =>
      row.getAttribute("data-message-id")
    )

  const view = render(ui({}))
  expect(anchors()).toEqual(["thinking"])

  view.rerender(
    ui({
      live: {
        ...createLiveRunState("run_2"),
        active: true,
        parts: [{ kind: "text", text: "and two more." }],
        partKeys: ["text#1#t"],
      },
    })
  )
  expect(anchors()).toEqual(["run:run_2"])
  queryClient.clear()
})
