import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import type { GetAuthSessionResponse } from "@sixb/client"
import { getAuthSessionQueryKey } from "@sixb/client/hooks"
import { Sidebar, SidebarFooter, SidebarProvider } from "@sixb/ui/components"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render } from "@testing-library/react"
import { Window } from "happy-dom"
import type { ReactNode } from "react"
import { MemoryRouter } from "react-router-dom"
import { AppShell, UserMenu } from "../src"

const browser = new Window({ url: "https://app.sixb.test" })
const globals = [
  "localStorage",
  "window",
  "self",
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
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
] as const
const previous = new Map<string, PropertyDescriptor | undefined>()

beforeAll(() => {
  const values = browser as unknown as Record<string, unknown>
  for (const key of globals) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value:
        key === "window" || key === "self"
          ? browser
          : key === "IS_REACT_ACT_ENVIRONMENT"
            ? true
            : values[key],
    })
  }
})

afterEach(() => {
  cleanup()
  browser.localStorage.clear()
})

afterAll(() => {
  for (const key of globals) {
    const descriptor = previous.get(key)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  browser.close()
})

const signedIn: GetAuthSessionResponse = {
  authenticated: true,
  applicationAccess: { allowed: true, audience: "app" },
  user: { id: "user-1", email: "morgan@example.com", displayName: "Morgan Reyes", groupIds: [] },
  session: { id: "session-1", expiresAt: "2026-10-15T00:00:00.000Z" },
}

function renderInApp(ui: ReactNode, path: string) {
  const queryClient = new QueryClient()
  queryClient.setQueryData(getAuthSessionQueryKey(), signedIn)
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
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
