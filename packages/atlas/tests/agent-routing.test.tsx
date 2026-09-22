import { expect, test } from "bun:test"

import { getAgentQueryKey, getAgentThreadQueryKey } from "@sixb/client/hooks"
import { ThemeProvider } from "@sixb/ui/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import App from "../src/App"

test("an Atlas thread URL opens that conversation in the shared full-page surface", () => {
  // Restore App.tsx, AppLayout.tsx and lib/agentSurface.ts from 71b650a4 to reproduce:
  // /agents/:threadId falls through to ProjectWorkspace, so the full-page surface disappears.
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin: "https://atlas.sixb.test" } },
  })
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "dark" },
  })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  cache.setQueryData(getAgentQueryKey(), {
    name: "Project assistant",
    model: { provider: "test", modelId: "test" },
  })
  cache.setQueryData(getAgentThreadQueryKey({ path: { threadId: "thread-42" } }), {
    id: "thread-42",
    projectId: "project",
    title: "Customer research",
    status: "active",
    ownerPrincipal: { type: "user", id: "user" },
    activeRunId: null,
    messageCount: 1,
    createdAt: "2026-09-01T12:00:00Z",
    updatedAt: "2026-09-01T12:00:00Z",
  })
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={cache}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/agents/thread-42"]}>
            <App />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>
    )
    expect(html).toContain('data-agent-surface="full"')
    expect(html).toContain("Thread history. Current: Customer research")
    expect(html).toContain('aria-label="Move assistant to side panel"')
  } finally {
    cache.clear()
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage)
    else Reflect.deleteProperty(globalThis, "localStorage")
  }
})
