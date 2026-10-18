import { expect, test } from "bun:test"
import { getAgentQueryKey } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { LocaleProvider } from "../src/locale"
import { HomePage } from "../src/pages"
import { installDom } from "./helpers/dom"

const browser = installDom([
  "localStorage",
  "sessionStorage",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "EventTarget",
  "MouseEvent",
  "KeyboardEvent",
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

function renderHome(agent: { readonly name: string } | null) {
  // Queries stay idle: the test supplies what the API would have answered.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } },
  })
  queryClient.setQueryData(
    getAgentQueryKey(),
    agent ? { ...agent, model: { provider: "test", modelId: "test" } } : null
  )
  return render(
    <QueryClientProvider client={queryClient}>
      <LocaleProvider>
        <MemoryRouter initialEntries={["/"]}>
          <HomePage />
        </MemoryRouter>
      </LocaleProvider>
    </QueryClientProvider>
  )
}

test("home asks the project's agent when the project has one", () => {
  const view = renderHome({ name: "Sixb" })

  expect(view.getByText("Ask your project.")).toBeDefined()
  expect(view.getByText("Then make it yours.")).toBeDefined()
  expect(view.getByRole("textbox", { name: "Message" })).toBeDefined()
})

test("home shows the app's name when there is no agent to ask", () => {
  browser.document.title = "Sentinel-6B Mission Tracker"

  const view = renderHome(null)

  expect(view.getByText("Sentinel-6B Mission Tracker")).toBeDefined()
  expect(view.getByText("There's nothing here yet.")).toBeDefined()
  expect(view.queryByRole("textbox", { name: "Message" })).toBeNull()
})
