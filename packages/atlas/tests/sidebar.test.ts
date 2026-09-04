import { expect, test } from "bun:test"
import { client } from "@sixb/client"
import { SidebarProvider } from "@sixb/ui/components"
import { ThemeProvider } from "@sixb/ui/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AtlasSidebarHeader, Sidebar } from "../src/components/layout/Sidebar"

test("keeps the Atlas name and project without a brand mark", () => {
  // Restoring the branded icon in AtlasSidebarHeader reintroduces an SVG.
  const html = renderToStaticMarkup(
    createElement(AtlasSidebarHeader, {
      selectedProject: { name: "northline" },
    })
  )
  expect(html).toContain("Sixb Atlas")
  expect(html).toContain("northline")
  expect(html).not.toContain("<svg")
})

test("presents a single Agent destination without a catalog count", () => {
  // Restoring the plural label fails this assertion; other catalog counts remain visible.
  const previousConfig = client.getConfig()
  client.setConfig({ baseUrl: "http://localhost:3002" })
  try {
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(
          ThemeProvider,
          null,
          createElement(
            SidebarProvider,
            null,
            createElement(Sidebar, {
              selectedProject: { name: "northline" },
              viewMode: "home",
              onViewChange: () => undefined,
              datasetCount: 3,
            })
          )
        )
      )
    )
    const agentItem = html.split("</li>").find((item) => item.includes("<span>Agent</span>"))
    expect(agentItem).toBeDefined()
    expect(agentItem).not.toContain('data-sidebar="menu-badge"')
    expect(html).not.toContain("<span>Agents</span>")
    expect(html).toContain('data-sidebar="menu-badge"')
  } finally {
    client.setConfig(previousConfig)
  }
})
