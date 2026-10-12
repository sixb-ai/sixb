import { expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ConversationPanel, type ConversationPanelProps } from "../src/components/ConversationPanel"
import { createLiveRunState } from "../src/liveRun"
import type { AgentMessage } from "../src/types"

test.each([false, true])("shows the agent name without a brand avatar (compact: %s)", (compact) => {
  // Restoring AgentAvatar in the header or welcome state brings back the brand SVG.
  const html = renderPanel({ compact })
  expect(html).toContain(">Agent<")
  expect(html).not.toContain('viewBox="0 0 480 394"')
})

test.each([
  false,
  true,
])("keeps the composer available for existing threads (compact: %s)", (compact) => {
  expect(renderPanel({ compact, threadId: "existing-thread" })).toContain("<textarea")
})

test("replaces an interrupted turn's unsaved stream with a way to run it again", () => {
  // Regression proof: drop the interrupted check from Transcript's showLive; unsaved text renders.
  const html = renderPanel({
    threadId: "thread",
    live: {
      ...createLiveRunState("run"),
      parts: [{ kind: "text", text: "Unsaved partial answer" }],
      partKeys: ["text#1#t"],
      finishStatus: "cancelled",
      finishReason: "interrupted",
    },
    interrupted: { hasProgress: false },
    onRetry: () => {},
  })
  expect(html).toContain("The response was interrupted before it finished.")
  expect(html).toContain("Try again")
  expect(html).not.toContain("Unsaved partial answer")
})

test("offers to continue a turn interrupted with its partial answer saved", () => {
  const html = renderPanel({
    threadId: "thread",
    live: {
      ...createLiveRunState("run"),
      parts: [{ kind: "text", text: "Saved partial answer" }],
      partKeys: ["text#1#t"],
      finalizedMessageId: "message",
      finishStatus: "cancelled",
      finishReason: "interrupted",
    },
    interrupted: { hasProgress: true },
    onContinue: () => {},
  })
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
  const messages = [answer("older", "step_limit_reached"), answer("newest", "output_limit_reached")]
  const html = renderPanel({ threadId: "thread", messages, onContinue: () => {} })
  expect(html).toContain("I ran out of room before finishing this answer.")
  expect(html.match(/>Continue</g)).toHaveLength(1)
  expect(html.indexOf(">Continue<")).toBeGreaterThan(html.indexOf("Answer newest"))

  expect(renderPanel({ threadId: "thread", messages })).not.toContain(">Continue<")
  const pending = renderPanel({
    threadId: "thread",
    messages,
    onContinue: () => {},
    continuing: true,
  })
  expect(pending).toContain("Continuing…")
  expect(pending).toMatch(/<button[^>]*disabled=""[^>]*>.*Continuing…/)
})

function renderPanel(props: Partial<ConversationPanelProps>): string {
  const cache = new QueryClient()
  const noop = () => {}
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: cache },
        createElement(ConversationPanel, {
          agent: undefined,
          threadId: null,
          messages: [],
          live: createLiveRunState(),
          messagesLoading: false,
          messagesError: null,
          awaitingResponse: false,
          reconnecting: false,
          agentThreads: [],
          currentThread: null,
          runningThreadCount: 0,
          onSend: noop,
          onNewChat: noop,
          onSelectThread: noop,
          composerDisabled: false,
          composerPending: false,
          composerRunning: false,
          composerStopping: false,
          onStop: noop,
          models: [],
          onSelectModel: noop,
          onSelectReasoning: noop,
          ...props,
        })
      )
    )
  } finally {
    cache.clear()
  }
}
