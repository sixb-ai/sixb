import { expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ConversationPanel, type ConversationPanelProps } from "../src/components/ConversationPanel"
import { createLiveRunState } from "../src/liveRun"

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
