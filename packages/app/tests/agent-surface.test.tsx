import { expect, test } from "bun:test"
import { getAgentOptions } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AgentSurface, type AgentSurfaceMode, type AgentSurfaceProps } from "../src"

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
