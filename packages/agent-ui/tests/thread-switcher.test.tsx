import { expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { ConversationPanel, type ConversationPanelProps } from "../src/components/ConversationPanel"
import { createLiveRunState } from "../src/liveRun"
import type { Agent, AgentThread } from "../src/types"

const agent: Agent = {
  name: "Operations Assistant",
  model: { provider: "test", modelId: "test-model" },
}

function thread(id: string, title: string): AgentThread {
  return {
    id,
    projectId: "project",
    ownerPrincipal: { type: "user", id: "user" },
    title,
    status: "active",
    activeRunId: null,
    messageCount: 1,
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
  }
}

function renderPanel(
  currentThread: AgentThread | null,
  overrides: Partial<ConversationPanelProps> = {}
): string {
  const props: ConversationPanelProps = {
    agent,
    threadId: currentThread?.id ?? null,
    messages: [],
    live: createLiveRunState(),
    messagesLoading: false,
    messagesError: null,
    awaitingResponse: false,
    reconnecting: false,
    currentThread,
    agentThreads: [thread("recent", "Recent customer research")],
    runningThreadCount: 0,
    onSend: () => {},
    onNewChat: () => {},
    onSelectThread: () => {},
    composerDisabled: false,
    composerPending: false,
    composerRunning: false,
    composerStopping: false,
    onStop: () => {},
    models: [],
    onSelectModel: () => {},
    onSelectReasoning: () => {},
    compact: true,
    ...overrides,
  }

  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ConversationPanel {...props} />
    </QueryClientProvider>
  )
}

test("compact chat exposes thread history and a direct new-thread action", () => {
  const html = renderPanel(thread("current", "Current customer research"))

  expect(html).toContain('aria-label="Thread history. Current: Current customer research"')
  expect(html).toContain('aria-label="New thread"')
  expect(html).not.toContain('aria-label="Recent chats"')
  expect(html).not.toContain(">Operations Assistant</span>")
})

test("compact chat labels an unsent conversation as a new thread", () => {
  expect(renderPanel(null)).toContain('aria-label="Thread history. Current: New thread"')
})

test("thread history shows a rotating active count while runs are in flight", () => {
  const html = renderPanel(thread("current", "Current customer research"), {
    runningThreadCount: 2,
  })

  expect(html).toContain('data-active-thread-count="2"')
  expect(html).toContain("animate-spin")
  expect(html).toContain(
    'aria-label="2 threads running. Open thread history. Current: Current customer research"'
  )
  expect(html).not.toContain("lucide-history")
})

test("an empty conversation shows host welcome content in place of the agent name", () => {
  const html = renderPanel(null, { welcomeContent: <div>Northline Mechanical</div> })

  expect(html).toContain("Northline Mechanical")
  expect(html).not.toContain(">Operations Assistant</p>")
})

test("an empty conversation falls back to the agent name, and null welcome content hides it", () => {
  expect(renderPanel(null)).toContain(">Operations Assistant</p>")
  expect(renderPanel(null, { welcomeContent: null })).not.toContain(">Operations Assistant</p>")
})

test("compact conversation chrome accepts host workspace actions", () => {
  const html = renderPanel(thread("current", "Current customer research"), {
    headerActions: <button aria-label="Expand conversation" />,
  })

  expect(html).toContain('aria-label="Expand conversation"')
})

test("sandbox recovery remains visible in an empty conversation", () => {
  // Regression proof: remove sandboxRecovery from the empty composer layout; this fails.
  const html = renderPanel(null, {
    sandboxRecovery: <div>Sandbox recovery required</div>,
    composerDisabled: true,
  })
  expect(html).toContain("Sandbox recovery required")
})
