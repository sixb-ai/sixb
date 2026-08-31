import { expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { AgentChatPage } from "../src/react-router"

test("workspace sidebar keeps host chrome and width while agents load", () => {
  const queryClient = new QueryClient()
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        MemoryRouter,
        { initialEntries: ["/agents"] },
        createElement(AgentChatPage, {
          routeBase: "/agents",
          sidebarHeader: createElement("div", { "data-host-header": true }, "Host header"),
          sidebarFooter: createElement("div", { "data-host-footer": true }, "Host footer"),
          sidebarWidth: "13rem",
        })
      )
    )
  )

  expect(html).toContain('data-host-header="true"')
  expect(html).toContain('data-host-footer="true"')
  expect(html).toContain("width:13rem")
  expect(html).toContain('aria-busy="true"')

  const sidebarTag = html.match(/<aside[^>]*aria-label="Agent threads"[^>]*>/)?.[0]
  expect(sidebarTag).toBeDefined()
  expect(sidebarTag).not.toContain("animate-in")
  expect(html).toContain("motion-safe:animate-in")
})
