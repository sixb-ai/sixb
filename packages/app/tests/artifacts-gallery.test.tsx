import { describe, expect, test } from "bun:test"
import { client, type ListArtifactsResponse } from "@sixb/client"
import { listArtifactsInfiniteQueryKey } from "@sixb/client/hooks"
import type { ArtifactKind } from "@sixb/core/artifacts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { ArtifactsPage } from "../src/artifacts/gallery"
import { artifactVersion, seedVersion } from "./helpers/artifacts"
import { installDom } from "./helpers/dom"

// Cards never near the screen here, so none of them reads its version over a network there is not.
class QuietObserver {
  observe() {}
  disconnect() {}
}
installDom(
  [
    "document",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "FocusEvent",
    "EventTarget",
    "MutationObserver",
    "getComputedStyle",
  ],
  { values: { IntersectionObserver: QuietObserver } }
)

const artifact = (
  id: string,
  kind: ArtifactKind,
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

function renderGallery(cache: QueryClient) {
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
  return { ui, cards }
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
    const { ui, cards } = renderGallery(cache)
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

  test("filters by kind from one tab stop, stepped through with the arrow keys", async () => {
    // Reproduce with a group of plain buttons, as before: each kind is its own tab stop, and the
    // arrow keys do nothing.
    const cache = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
    seed(cache, undefined, [])
    const { ui } = renderGallery(cache)
    // No kind is a stop of its own: the group is, and it hands focus on to the chosen kind.
    expect(ui.getByRole("radiogroup", { name: "Filter by kind" })).toBeTruthy()
    expect(ui.getAllByRole("radio").map((radio) => radio.getAttribute("tabindex"))).toEqual(
      Array.from({ length: 5 }, () => "-1")
    )
    const all = ui.getByRole("radio", { name: "All" })
    expect(all.getAttribute("aria-checked")).toBe("true")

    act(() => all.focus())
    fireEvent.keyDown(all, { key: "ArrowRight" })
    // The group moves focus on a later tick.
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(
        ui.getByRole("radio", { name: "Documents" }).textContent
      )
    )
  })

  test("shows each artifact once when an update moves it onto the next page", () => {
    // Reproduce by flattening the pages without dropping repeats: the sheet shows twice.
    const cache = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
    const sheet = artifact("art_m3tr1csq3a", "sheet", "Q3 service metrics")
    cache.setQueryData(listArtifactsInfiniteQueryKey({ query: { limit: "24" } } as never), {
      pages: [
        { artifacts: [artifact("art_q3rep9rt00", "document", "Q3 report"), sheet], hasMore: true },
        { artifacts: [sheet, artifact("art_q3dec4000", "slides", "Q3 review")], hasMore: false },
      ].map((page) => ({ ...page, total: 3 })),
      pageParams: ["0", "24"],
    })
    const { cards } = renderGallery(cache)
    expect(cards().map((card) => card.getAttribute("href"))).toEqual([
      "/artifacts/art_q3rep9rt00",
      "/artifacts/art_m3tr1csq3a",
      "/artifacts/art_q3dec4000",
    ])
  })

  test("shows a deck's first slide title on its card until, or unless, the live slide shows", () => {
    // Reproduce by dropping FirstSlide's fallback: the frame never loads here, and the slide is
    // blank.
    const cache = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
    seed(cache, undefined, [artifact("art_q3dec4000", "slides", "Q3 2026 operations review")])
    seedVersion(
      cache,
      artifactVersion({
        artifactId: "art_q3dec4000",
        title: "Q3 2026 operations review",
        entry: "index.html",
        outline: {
          kind: "slides",
          slides: [
            { title: "Restorations within SLA reached 94%" },
            ...Array.from({ length: 5 }, () => ({})),
          ],
        },
      })
    )
    const { cards } = renderGallery(cache)
    expect(cards()[0]?.textContent).toContain("Restorations within SLA reached 94%")
    expect(cards()[0]?.textContent).toContain("1 / 6")
  })

  test("says when the server has no artifact storage, where trying again cannot help", async () => {
    // Reproduce by dropping the 501 case from ArtifactsPage: the page offers Try again.
    const original = client.getConfig()
    const api = async () =>
      Response.json({ error: "Artifact storage is not configured." }, { status: 501 })
    client.setConfig({
      baseUrl: "https://api.sixb.test",
      fetch: Object.assign(api, { preconnect: fetch.preconnect }),
    })
    try {
      const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      const { ui } = renderGallery(cache)
      expect(await ui.findByText("Artifact storage is not available.")).toBeTruthy()
      expect(ui.queryByRole("button", { name: "Try again" })).toBeNull()
    } finally {
      client.setConfig({ baseUrl: original.baseUrl, fetch: original.fetch })
    }
  })
})
