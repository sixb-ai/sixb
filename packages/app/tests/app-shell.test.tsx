import { afterEach, expect, test } from "bun:test"
import type { GetAuthSessionResponse } from "@sixb/client"
import { getAgentQueryKey, getAuthSessionQueryKey } from "@sixb/client/hooks"
import { Sidebar, SidebarFooter, SidebarProvider } from "@sixb/ui/components"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render } from "@testing-library/react"
import type { ReactNode } from "react"
import { MemoryRouter } from "react-router-dom"
import { AppShell, UserMenu } from "../src"
import { SectionsProvider } from "../src/pages"
import { installDom } from "./helpers/dom"

const browser = installDom([
  "localStorage",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

afterEach(() => {
  browser.localStorage.clear()
})

const signedIn: GetAuthSessionResponse = {
  authenticated: true,
  user: { id: "user-1", email: "morgan@example.com", displayName: "Morgan Reyes", groupIds: [] },
  session: { id: "session-1", expiresAt: "2026-10-15T00:00:00.000Z" },
}

function renderInApp(
  ui: ReactNode,
  path: string,
  options: { readonly sections?: boolean; readonly agent?: boolean } = {}
) {
  // Cached answers never go stale, so nothing tries to reach an API.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  })
  queryClient.setQueryData(getAuthSessionQueryKey(), signedIn)
  queryClient.setQueryData(
    getAgentQueryKey(),
    options.agent ? { name: "Sixb", model: { provider: "test", modelId: "test" } } : null
  )
  const app = <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
  return render(
    <QueryClientProvider client={queryClient}>
      {options.sections ? <SectionsProvider visibility={undefined}>{app}</SectionsProvider> : app}
    </QueryClientProvider>
  )
}

test("AppShell draws the brand, nav data with the current page marked, and the signed-in person", () => {
  browser.document.title = "ECIS"

  const view = renderInApp(
    <AppShell
      nav={[
        { label: "Home", href: "/" },
        {
          group: "Operations",
          items: [
            { label: "Quotes", href: "/quotes", badge: 3 },
            { label: "Job sites", href: "/sites" },
          ],
        },
      ]}
    >
      <p>Quote page</p>
    </AppShell>,
    "/quotes/q-17"
  )

  expect(view.getAllByText("ECIS").length).toBeGreaterThan(0)
  expect(view.getByText("Operations")).toBeDefined()
  expect(view.getByText("3")).toBeDefined()
  expect(view.getByText("Quote page")).toBeDefined()
  expect(view.getByText("Morgan Reyes")).toBeDefined()

  const quotes = view.getByText("Quotes").closest("a")
  const home = view.getByText("Home").closest("a")
  expect(quotes?.getAttribute("href")).toBe("/quotes")
  expect(quotes?.getAttribute("data-active")).toBe("true")
  expect(home?.getAttribute("data-active")).toBe("false")
})

test("UserMenu works in a sidebar built by hand, without a theme provider", () => {
  const view = renderInApp(
    <SidebarProvider>
      <Sidebar>
        <SidebarFooter>
          <UserMenu>
            <UserMenu.Item href="/release-notes">Release notes</UserMenu.Item>
          </UserMenu>
        </SidebarFooter>
      </Sidebar>
    </SidebarProvider>,
    "/"
  )

  expect(view.getByText("Morgan Reyes")).toBeDefined()
})

// Regression proof: drop the `useSectionsEnabled` check from SearchCommand and the shared-link
// case finds a Search button.
test("AppShell offers Search in the app, not with header={null}, and not on a shared link", () => {
  const shell = (header?: null) => (
    <AppShell nav={[{ label: "Quotes", href: "/quotes" }]} header={header}>
      <p>Quote page</p>
    </AppShell>
  )

  const search = (view: ReturnType<typeof renderInApp>) => view.queryAllByText("Search").length

  expect(search(renderInApp(shell(), "/quotes", { sections: true }))).toBeGreaterThan(0)
  cleanup()
  expect(search(renderInApp(shell(null), "/quotes", { sections: true }))).toBe(0)
  cleanup()
  // A shared link renders the app's layout without its sections.
  expect(search(renderInApp(shell(), "/quotes"))).toBe(0)
})

// Regression proof: drop the `conversationPage` check from AgentDock and Home gets the launcher.
test("the agent waits docked beside app pages, but not on Home or without an agent", () => {
  const shell = (
    <AppShell nav={[{ label: "Quotes", href: "/quotes" }]}>
      <p>Page</p>
    </AppShell>
  )
  const launcher = (path: string, agent: boolean) => {
    const view = renderInApp(shell, path, { sections: true, agent })
    const found = view.queryByRole("button", { name: "Ask the agent" }) !== null
    cleanup()
    return found
  }

  expect(launcher("/quotes", true)).toBe(true)
  expect(launcher("/", true)).toBe(false)
  expect(launcher("/threads", true)).toBe(false)
  expect(launcher("/threads/thread-1", true)).toBe(false)
  expect(launcher("/quotes", false)).toBe(false)
})
