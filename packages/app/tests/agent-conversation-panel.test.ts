import { expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  ConversationPanel,
  type ConversationPanelProps,
} from "../src/agent/components/conversation-panel"
import type { TranscriptProps } from "../src/agent/components/transcript"
import {
  type ConversationMessagesInput,
  conversationMessages,
  conversationTurn,
  READ_ONLY_TURN,
} from "../src/agent/conversation"
import { createLiveRunState } from "../src/agent/live-run"
import type { ActiveTurnPresentation } from "../src/agent/run-presentation"
import type { AgentMessage, AgentRun, AgentThread } from "../src/agent/types"

function thread(id: string, title: string): AgentThread {
  return {
    id,
    projectId: "project",
    kind: "conversation",
    ownerPrincipal: { type: "user", id: "user" },
    owner: { type: "user", id: "user" },
    participants: [],
    title,
    status: "active",
    activeRunId: null,
    messageCount: 1,
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
  }
}

const current = thread("current", "Current customer research")

test("compact chat exposes thread history and a direct new-thread action", () => {
  const html = renderPanel({ compact: true, currentThread: current }, { threadId: current.id })

  expect(html).toContain('aria-label="Thread history. Current: Current customer research"')
  expect(html).toContain('aria-label="New thread"')
  expect(html).not.toContain('aria-label="Recent chats"')
  expect(html).not.toContain(">Operations Assistant</span>")
  // An unsent conversation is a new thread.
  expect(renderPanel({ compact: true })).toContain(
    'aria-label="Thread history. Current: New thread"'
  )
})

test("thread history shows a rotating active count while runs are in flight", () => {
  const html = renderPanel(
    { compact: true, currentThread: current, runningThreadCount: 2 },
    { threadId: current.id }
  )

  expect(html).toContain('data-active-thread-count="2"')
  expect(html).toContain("animate-spin")
  expect(html).toContain(
    'aria-label="2 threads running. Open thread history. Current: Current customer research"'
  )
  expect(html).not.toContain("lucide-history")
})

test("an empty conversation shows host welcome content in place of the agent name", () => {
  for (const compact of [false, true]) {
    expect(renderPanel({ compact })).toContain(">Operations Assistant</p>")
  }
  const welcome = renderPanel({
    welcomeContent: createElement("div", null, "Northline Mechanical"),
  })
  expect(welcome).toContain("Northline Mechanical")
  expect(welcome).not.toContain(">Operations Assistant</p>")
  // Null welcome content hides the name.
  expect(renderPanel({ welcomeContent: null })).not.toContain(">Operations Assistant</p>")
})

test("sandbox recovery remains visible in an empty conversation", () => {
  // Regression proof: remove sandboxRecovery from the empty composer layout; this fails.
  const html = renderPanel({
    sandboxRecovery: createElement("div", null, "Sandbox recovery required"),
    composer: { ...composer, disabled: true },
  })
  expect(html).toContain("Sandbox recovery required")
})

test("replaces an interrupted turn's unsaved stream with a way to run it again", () => {
  // Regression proof: drop the interrupted check from liveReply in conversationMessages; unsaved
  // text renders.
  const html = renderPanel(
    {},
    {
      threadId: "thread",
      ...conversation({
        messages: [question],
        live: {
          ...createLiveRunState("run"),
          parts: [{ kind: "text", text: "Unsaved partial answer" }],
          partKeys: ["text#1#t"],
          finishStatus: "cancelled",
          finishReason: "interrupted",
        },
        presentation: { kind: "interrupted", run: interruptedRun, hasProgress: false },
      }),
      onRetry: () => {},
    }
  )
  expect(html).toContain("The response was interrupted before it finished.")
  expect(html).toContain("Try again")
  expect(html).not.toContain("Unsaved partial answer")
})

test("offers to continue a turn interrupted with its partial answer saved", () => {
  const html = renderPanel(
    {},
    {
      threadId: "thread",
      ...conversation({
        live: {
          ...createLiveRunState("run"),
          parts: [{ kind: "text", text: "Saved partial answer" }],
          partKeys: ["text#1#t"],
          finalizedMessageId: "message",
          finishStatus: "cancelled",
          finishReason: "interrupted",
        },
        presentation: { kind: "interrupted", run: interruptedRun, hasProgress: true },
      }),
      onContinue: () => {},
    }
  )
  expect(html).toContain("Saved partial answer")
  expect(html).toContain("The response was interrupted before it finished.")
  expect(html).toContain("Continue")
  expect(html).not.toContain("Try again")
})

test("offers Continue on the newest answer that stopped short, not on older ones", () => {
  // Removal proof: pass onContinue to every TranscriptMessage; the older notice offers it too.
  const answer = (id: string, code: AgentMessage["annotations"][number]["code"]): AgentMessage => ({
    id,
    projectId: "project",
    threadId: "thread",
    runId: `run-${id}`,
    role: "assistant",
    seq: 1,
    parts: [{ type: "text", text: `Answer ${id}` }],
    annotations: [{ code, severity: "warning", scope: "run", message: "Developer copy." }],
    contentVersion: 1,
    createdAt: "2026-10-12T10:00:00.000Z",
  })
  const { messages } = conversation({
    messages: [answer("older", "step_limit_reached"), answer("newest", "output_limit_reached")],
  })
  const html = renderPanel({}, { threadId: "thread", messages, onContinue: () => {} })
  expect(html).toContain("I ran out of room before finishing this answer.")
  expect(html.match(/>Continue</g)).toHaveLength(1)
  expect(html.indexOf(">Continue<")).toBeGreaterThan(html.indexOf("Answer newest"))

  expect(renderPanel({}, { threadId: "thread", messages })).not.toContain(">Continue<")
  const pending = renderPanel(
    {},
    {
      threadId: "thread",
      messages,
      turn: conversationTurn({ ...READ_ONLY_TURN, continuing: true, ...idle }),
      onContinue: () => {},
    }
  )
  expect(pending).toContain("Continuing…")
  expect(pending).toMatch(/<button[^>]*disabled=""[^>]*>.*Continuing…/)
})

const noop = () => {}

const idle = { presentation: { kind: "idle" }, activeRunId: null } as const

const question: AgentMessage = {
  id: "question",
  projectId: "project",
  threadId: "thread",
  runId: null,
  role: "user",
  seq: 1,
  parts: [{ type: "text", text: "Summarize the incident." }],
  annotations: [],
  contentVersion: 1,
  createdAt: "2026-10-12T10:00:00.000Z",
}

const interruptedRun: AgentRun = {
  id: "run",
  projectId: "project",
  kind: "conversation",
  threadId: "thread",
  triggerMessageId: "question",
  attempt: 0,
  streamId: "agents.runs.run",
  status: "cancelled",
  finishReason: "interrupted",
  createdAt: "2026-10-12T10:00:00.000Z",
}

/** The transcript's messages and turn, merged as the conversation hook merges them. */
function conversation(
  input: Partial<ConversationMessagesInput> & { readonly presentation?: ActiveTurnPresentation }
): Pick<TranscriptProps, "messages" | "turn"> {
  const presentation = input.presentation ?? idle.presentation
  return {
    messages: conversationMessages({ messages: [], ...input, presentation }),
    turn: conversationTurn({ ...READ_ONLY_TURN, presentation, activeRunId: null }),
  }
}

const composer: ConversationPanelProps["composer"] = {
  onSend: noop,
  disabled: false,
  pending: false,
  running: false,
  stopping: false,
  onStop: noop,
  models: [],
  onSelectModel: noop,
  onSelectReasoning: noop,
}

function renderPanel(
  props: Partial<ConversationPanelProps>,
  transcript: Partial<TranscriptProps> = {}
): string {
  const cache = new QueryClient()
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: cache },
        createElement(ConversationPanel, {
          agent: { name: "Operations Assistant", model: { provider: "test", modelId: "test" } },
          transcript: {
            threadId: null,
            ...conversation({}),
            ...transcript,
          },
          composer,
          messagesLoading: false,
          messagesError: null,
          agentThreads: [thread("recent", "Recent customer research")],
          currentThread: null,
          runningThreadCount: 0,
          onNewChat: noop,
          onSelectThread: noop,
          ...props,
        })
      )
    )
  } finally {
    cache.clear()
  }
}
