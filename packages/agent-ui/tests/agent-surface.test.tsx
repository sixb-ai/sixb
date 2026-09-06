import { expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AgentSurface, type AgentSurfaceMode } from "../src"

function renderSurface(mode?: AgentSurfaceMode, fullPage = false): string {
  const queryClient = new QueryClient()
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(AgentSurface, {
        agentId: "operations-assistant",
        ...(mode ? { mode } : {}),
        fullPage,
        title: "Operations Assistant",
        launcherLabel: "Ask Operations",
      })
    )
  )
}

test("adaptive agent surface exposes only the collapsed launcher and compact dock", () => {
  const collapsed = renderSurface("collapsed")
  expect(collapsed).toContain('data-agent-surface="collapsed"')
  expect(collapsed).toContain('aria-label="Ask Operations"')
  expect(collapsed).toContain('aria-hidden="true"')

  const dock = renderSurface("dock")
  expect(dock).toContain('data-agent-surface="dock"')
  expect(dock).toContain('data-agent-document-host=""')
  expect(dock).toContain('aria-label="Collapse assistant"')
  expect(dock).toContain('aria-label="Resize assistant"')
  expect(dock).not.toContain(">Operations Assistant</span>")
  expect(dock).not.toContain('aria-label="Expand assistant workspace"')
  expect(dock).not.toContain('aria-label="Agent threads"')
})

test("adaptive agent surface defaults to an uncontrolled resizable dock", () => {
  const dock = renderSurface()

  expect(dock).toContain('data-agent-surface="dock"')
  expect(dock).toContain("--agent-surface-width:384px")
  expect(dock).toContain('aria-label="Resize assistant"')
  expect(dock).not.toContain('aria-label="Ask Operations"')
})

test("the adaptive surface reuses the conversation as a full page", () => {
  const page = renderSurface("collapsed", true)

  expect(page).toContain('data-agent-surface="full"')
  expect(page).toContain('aria-label="Move assistant to side panel"')
  expect(page).not.toContain('aria-label="Collapse assistant"')
  expect(page).not.toContain('aria-label="Resize assistant"')
  expect(page).not.toContain('aria-label="Ask Operations"')
})
