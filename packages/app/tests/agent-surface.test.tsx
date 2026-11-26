import { expect, test } from "bun:test"
import { getAgentOptions } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { AgentSurface, type AgentSurfaceMode, type AgentSurfaceProps } from "../src"
import { AgentChatPage, AgentThreadsPage } from "../src/agent/react-router"

function renderSurface(
  mode?: AgentSurfaceMode,
  fullPage = false,
  canDock = true,
  overrides: Partial<AgentSurfaceProps> = {}
): string {
  const queryClient = new QueryClient()
  queryClient.setQueryData(getAgentOptions().queryKey, {
    name: "Sixb",
    model: { provider: "test", modelId: "test-model" },
  })
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(AgentSurface, {
        ...(mode ? { mode } : {}),
        fullPage,
        onRequestDock: canDock ? () => {} : undefined,
        title: "Operations Assistant",
        launcherLabel: "Ask Operations",
        ...overrides,
      })
    )
  )
}

test("adaptive agent surface exposes only the collapsed launcher and compact dock", () => {
  const collapsed = renderSurface("collapsed")
  expect(collapsed).toContain('data-agent-surface="collapsed"')
  expect(collapsed).toContain('aria-label="Ask Operations"')
  expect(collapsed).toContain('aria-hidden="true"')

  // Without a mode, the surface is an uncontrolled, resizable dock at its default width.
  const dock = renderSurface()
  expect(dock).toContain('data-agent-surface="dock"')
  expect(dock).toContain("--agent-surface-width:384px")
  expect(dock).toContain('data-agent-artifact-host=""')
  expect(dock).toContain('aria-label="Collapse assistant"')
  expect(dock).toContain('aria-label="Resize assistant"')
  expect(dock).not.toContain(">Operations Assistant</span>")
  expect(dock).not.toContain('aria-label="Expand assistant workspace"')
  expect(dock).not.toContain('aria-label="Agent threads"')
})

test("the adaptive surface reuses the conversation as a full page", () => {
  const page = renderSurface("collapsed", true)

  expect(page).toContain('data-agent-surface="full"')
  expect(page).toContain('aria-label="Move assistant to side panel"')
  expect(page).not.toContain('aria-label="Collapse assistant"')
  expect(page).not.toContain('aria-label="Resize assistant"')
  expect(page).not.toContain('aria-label="Ask Operations"')
})

test("full-page mode omits the dock action when the host cannot navigate back", () => {
  // Removing the onRequestDock guard restores an inert minimize button.
  expect(renderSurface("dock", true, false)).not.toContain(
    'aria-label="Move assistant to side panel"'
  )
})

test("the adaptive surface passes host welcome content to its conversation", () => {
  // Dropping welcomeContent from AgentSurface's AgentPanel falls back to the agent name here.
  const dock = renderSurface("dock", false, true, {
    welcomeContent: <p>Northline Mechanical</p>,
  })

  expect(dock).toContain("<p>Northline Mechanical</p>")
  expect(dock).not.toContain(">Sixb</p>")
})

// The conversations and a conversation are pages of their own, over the app: they start below a
// bar above it, such as a branch's, which they once covered whole. Red check: put `inset-0` back on
// either page's root (`agent/react-router.tsx`).
test("the conversation pages start below a bar above the app", () => {
  const offset = /^<section class="fixed inset-x-0 top-\[var\(--app-top-inset,0px\)\] /
  const page = (element: ReturnType<typeof createElement>, path: string) =>
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { enabled: false } } }) },
        createElement(MemoryRouter, { initialEntries: [path] }, element)
      )
    )

  expect(page(createElement(AgentThreadsPage), "/threads")).toMatch(offset)
  expect(page(createElement(AgentChatPage), "/threads/thr_1")).toMatch(offset)
})

// On a phone the dock fills the screen: it starts below a bar above the app, such as a branch's,
// which it once covered whole. Red check: put `max-sm:inset-y-0` back on the dock
// (`agent/agent-surface.tsx`).
test("the dock fills a phone below a bar above the app", () => {
  const dock = renderSurface("dock")

  expect(dock).toMatch(
    /data-agent-surface="dock"[^>]*class="[^"]*max-sm:top-\[var\(--app-top-inset,0px\)\] max-sm:bottom-0/
  )
  expect(dock).not.toContain("max-sm:inset-y-0")
})
