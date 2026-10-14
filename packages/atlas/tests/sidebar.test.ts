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
              onOpenCommand: () => undefined,
              workflowCount: 3,
            })
          )
        )
      )
    )
    const agentItem = html.split("</li>").find((item) => /<span[^>]*>Agent<\/span>/.test(item))
    expect(agentItem).toBeDefined()
    expect(agentItem).not.toContain('data-sidebar="menu-badge"')
    expect(html).not.toMatch(/<span[^>]*>Agents<\/span>/)
    expect(html).toContain('data-sidebar="menu-badge"')
  } finally {
    client.setConfig(previousConfig)
  }
})

test("links Settings to the project's app only when Atlas knows the app's address", () => {
  // Regression proof: drop <AppSettingsItem /> from the Operate group and the first case fails.
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
            viewMode: "home",
            onViewChange: () => undefined,
            onOpenCommand: () => undefined,
          })
        )
      )
    )
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __SIXB_ATLAS__: { appUrl: "https://app.example.test" } },
    })
    expect(render()).toContain('href="https://app.example.test/settings"')

    Object.defineProperty(globalThis, "window", { configurable: true, value: {} })
    expect(render()).not.toMatch(/<span[^>]*>Settings<\/span>/)
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
})
