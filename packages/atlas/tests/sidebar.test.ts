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

test("presents a single Agent destination", () => {
  // Restoring the plural label fails this assertion.
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
              viewMode: "agents",
              onViewChange: () => undefined,
              onOpenCommand: () => undefined,
            })
          )
        )
      )
    )
    const agentItem = html.split("</li>").find((item) => /<span[^>]*>Agent<\/span>/.test(item))
    expect(agentItem).toBeDefined()
    expect(html).not.toMatch(/<span[^>]*>Agents<\/span>/)
  } finally {
    client.setConfig(previousConfig)
  }
})

test("links the pages that moved to the project's app only when Atlas knows the app's address", () => {
  // Regression proof: drop the Settings AppLinkItem from the Operate group and the first case
  // fails; drop the filter on projectNavGroups and the second shows an empty Data group.
  const render = () =>
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(
          SidebarProvider,
          null,
          createElement(Sidebar, {
            selectedProject: { name: "northline" },
            viewMode: null,
            onViewChange: () => undefined,
            onOpenCommand: () => undefined,
          })
        )
      )
    )
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const previousConfig = client.getConfig()
  client.setConfig({ baseUrl: "http://localhost:3002" })
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __SIXB_ATLAS__: { appUrl: "https://app.example.test" } },
    })
    const linked = render()
    expect(linked).toContain('href="https://app.example.test/settings"')
    for (const page of ["connectors", "datasets", "syncs", "pipelines", "projections"]) {
      expect(linked).toContain(`href="https://app.example.test/data/${page}"`)
    }
    for (const page of ["object-types", "objects", "graph", "actions", "workflows", "rules"]) {
      expect(linked).toContain(`href="https://app.example.test/ontology/${page}"`)
    }

    Object.defineProperty(globalThis, "window", { configurable: true, value: {} })
    const unlinked = render()
    expect(unlinked).not.toMatch(/<span[^>]*>Settings<\/span>/)
    expect(unlinked).not.toMatch(/>Data</)
    expect(unlinked).not.toMatch(/<span[^>]*>Connectors<\/span>/)
    expect(unlinked).not.toMatch(/<span[^>]*>Objects<\/span>/)
  } finally {
    client.setConfig({ baseUrl: previousConfig.baseUrl })
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
})
