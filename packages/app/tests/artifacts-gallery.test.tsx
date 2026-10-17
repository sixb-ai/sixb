import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { ListArtifactsResponse } from "@sixb/client"
import { listArtifactsInfiniteQueryKey } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { Window } from "happy-dom"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { ArtifactsPage } from "../src/artifacts/gallery"

const browser = new Window({ url: "https://app.sixb.test" })
const globals = [
  "window",
  "self",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Event",
  "MouseEvent",
  "EventTarget",
  "getComputedStyle",
  "IS_REACT_ACT_ENVIRONMENT",
] as const
const previous = new Map<string, PropertyDescriptor | undefined>()
// Cards never near the screen here, so none of them reads its version over a network there is not.
class QuietObserver {
  observe() {}
  disconnect() {}
}
beforeAll(() => {
  previous.set(
    "IntersectionObserver",
    Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver")
  )
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    writable: true,
    value: QuietObserver,
  })
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
afterEach(() => cleanup())
afterAll(() => {
  for (const key of [...globals, "IntersectionObserver"]) {
    const descriptor = previous.get(key)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  browser.close()
})

const artifact = (
  id: string,
  kind: "document" | "sheet" | "slides" | "file",
  title: string,
  latestVersion = 1
): ListArtifactsResponse["artifacts"][number] => ({
  id,
  projectId: "northline",
  kind,
  title,
  owner: { type: "user", id: "usr_1" },
  latestVersion,
  createdAt: "2026-10-15T15:00:00.000Z",
  updatedAt: "2026-10-17T15:00:00.000Z",
})

/** The list as the page asks for it: 24 at a time, of one kind when filtered. */
function seed(
  cache: QueryClient,
  kind: string | undefined,
  artifacts: ListArtifactsResponse["artifacts"]
) {
  cache.setQueryData(
    listArtifactsInfiniteQueryKey({ query: { limit: "24", ...(kind ? { kind } : {}) } } as never),
    { pages: [{ artifacts, hasMore: false, total: artifacts.length }], pageParams: ["0"] }
  )
}

function Location() {
  const location = useLocation()
  return <output data-location="">{`${location.pathname}${location.search}`}</output>
}

describe("the artifacts gallery", () => {
  test("shows every artifact as a card that opens it, and filters by kind in the URL", async () => {
    const cache = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
    seed(cache, undefined, [
      artifact("art_q3dec4000", "slides", "Q3 2026 operations review"),
      artifact("art_m3tr1csq3a", "sheet", "Q3 service metrics", 3),
      artifact("art_q3rep9rt00", "document", "Q3 report"),
    ])
    seed(cache, "sheet", [artifact("art_m3tr1csq3a", "sheet", "Q3 service metrics", 3)])
    seed(cache, "file", [])
    const ui = render(
      <QueryClientProvider client={cache}>
        <MemoryRouter initialEntries={["/artifacts"]}>
          <Routes>
            <Route
              path="/artifacts"
              element={
                <>
                  <ArtifactsPage />
                  <Location />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
    const cards = () =>
      Array.from(ui.container.querySelectorAll<HTMLAnchorElement>("a[href^='/artifacts/']"))
    expect(cards().map((card) => card.getAttribute("href"))).toEqual([
      "/artifacts/art_q3dec4000",
      "/artifacts/art_m3tr1csq3a",
      "/artifacts/art_q3rep9rt00",
    ])
    expect(ui.getByText("3 artifacts")).toBeTruthy()
    // A later version says which one the card shows.
    expect(cards()[1]?.textContent).toContain("v3")

    await act(async () => {
      fireEvent.click(ui.getByRole("radio", { name: "Sheets" }))
    })
    expect(ui.container.querySelector("[data-location]")?.textContent).toBe("/artifacts?kind=sheet")
    expect(ui.getByRole("radio", { name: "Sheets" }).getAttribute("aria-checked")).toBe("true")
    expect(cards().map((card) => card.getAttribute("href"))).toEqual(["/artifacts/art_m3tr1csq3a"])
    expect(ui.getByText("1 sheet")).toBeTruthy()

    await act(async () => {
      fireEvent.click(ui.getByRole("radio", { name: "Files" }))
    })
    expect(ui.getByText("No files yet")).toBeTruthy()
    await act(async () => {
      fireEvent.click(ui.getByRole("button", { name: "Show all" }))
    })
    expect(ui.container.querySelector("[data-location]")?.textContent).toBe("/artifacts")
    expect(cards()).toHaveLength(3)
  })
})
