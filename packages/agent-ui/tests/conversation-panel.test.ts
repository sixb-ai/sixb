import { expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ConversationPanel } from "../src/components/ConversationPanel"
import { createLiveRunState } from "../src/liveRun"

test.each([false, true])("shows the agent name without a brand avatar (compact: %s)", (compact) => {
  // Restoring AgentAvatar in the header or welcome state brings back the brand SVG.
  const cache = new QueryClient()
  const noop = () => {}
  try {
    const html = renderToStaticMarkup(
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
          compact,
        })
      )
    )
    expect(html).toContain(">Agent<")
    expect(html).not.toContain('viewBox="0 0 480 394"')
  } finally {
    cache.clear()
  }
})
