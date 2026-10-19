import { describe, expect, test } from "bun:test"
import type { GetArtifactVersionResponse } from "@sixb/client"
import { FRAME_PROTOCOL } from "@sixb/core/artifacts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render } from "@testing-library/react"
import {
  ArtifactReferencesProvider,
  ReferencingMarkdown,
} from "../src/artifacts/references/references"
import { PageRenderer } from "../src/artifacts/renderers/page"
import type { ArtifactTarget } from "../src/artifacts/target"
import { seedVersion } from "./helpers/artifacts"
import { installDom } from "./helpers/dom"

const browser = installDom([
  "document",
  "navigator",
  "localStorage",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLIFrameElement",
  "Event",
  "MessageEvent",
  "MouseEvent",
  "WheelEvent",
  "EventTarget",
  "MutationObserver",
  "ResizeObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

const PAGE = "art_f133tp14n0"
const LINKED = "artifact:art_m3tr1csq3a#chart=sla-trend"
const EMBEDDED = "artifact:art_m3tr1csq3a#chart=crews"

function pageVersion(): GetArtifactVersionResponse {
  return {
    artifactId: PAGE,
    version: 1,
    title: "Fleet planner",
    entry: "index.html",
    files: [],
    outline: { kind: "page", title: "Fleet planner" },
    references: [
      { address: LINKED, as: "link", at: "", resolvedVersion: 3 },
      { address: EMBEDDED, as: "embed", at: "", resolvedVersion: 3 },
    ],
    author: { type: "user", id: "user-1" },
    createdAt: "2026-10-18T12:00:00.000Z",
  }
}

/** A cache that reads nothing itself, with the page's frame link minted already. */
function frameCache(version: GetArtifactVersionResponse): QueryClient {
  const cache = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
  cache.setQueryData(["artifact-frame", version.artifactId, version.version], {
    path: "/api/artifact-frames/token/",
    expiresAt: "2026-10-18T13:00:00.000Z",
  })
  return cache
}

function mount() {
  const version = pageVersion()
  const opened: ArtifactTarget[] = []
  const ui = render(
    <QueryClientProvider client={frameCache(version)}>
      <ArtifactReferencesProvider open={(target) => opened.push(target)}>
        <PageRenderer version={version} />
      </ArtifactReferencesProvider>
    </QueryClientProvider>
  )
  return { ...frameOf(ui.container.querySelector("iframe")), ui, opened }
}

/** What the app posted to a frame, and a way to post as the frame: ready, and themed. */
function frameOf(frame: HTMLIFrameElement | null) {
  const target = frame?.contentWindow
  if (!frame || !target) throw new Error("Expected the page's frame.")
  const posted: Record<string, unknown>[] = []
  target.postMessage = ((message: Record<string, unknown>) => {
    posted.push(message)
  }) as never
  const post = async (data: Record<string, unknown>) => {
    await act(async () => {
      browser.dispatchEvent(
        new browser.MessageEvent("message", {
          data: { protocol: FRAME_PROTOCOL, ...data },
          source: target as never,
        })
      )
    })
  }
  const show = async () => {
    await post({ event: "ready", params: {} })
    await post({ id: posted.find((message) => message.method === "theme")?.id })
  }
  return { frame, posted, post, show }
}

describe("a page", () => {
  test("opens its entry in a sandboxed frame named for it, shown once it is ready and themed", async () => {
    const { frame, posted, post } = mount()
    expect(frame.getAttribute("src")).toEndWith("/api/artifact-frames/token/index.html")
    expect(frame.getAttribute("title")).toBe("Page Fleet planner")
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals"
    )
    expect(frame.className).toContain("opacity-0")

    // A page's ready names no slides.
    await post({ event: "ready", params: {} })
    const theme = posted.find((message) => message.method === "theme")
    expect(theme).toBeDefined()
    await post({ id: theme?.id })
    expect(frame.className).toContain("opacity-100")
  })

  test("opens only the artifacts it linked to when it was published", async () => {
    // Reproduce by opening every address the frame posts: the page's scripts could send the
    // reader anywhere they can read.
    const { post, opened } = mount()
    await post({ event: "open", params: { address: "artifact:art_0therw1se0" } })
    expect(opened).toEqual([])
    await post({ event: "open", params: { address: LINKED } })
    expect(opened).toEqual([
      { type: "artifact", artifactId: "art_m3tr1csq3a", part: "chart=sla-trend" },
    ])
  })
})

describe("a page's embeds", () => {
  test("are drawn where the page reports them as it scrolls, only those it published with", async () => {
    // Reproduce by dropping `onEmbeds` from the page's events, or by drawing every address the
    // frame posts: the boxes stay empty, or show what the page never published with.
    const { ui, show, post } = mount()
    await show()
    const rect = (y: number) => ({ x: 32, y, width: 640, height: 360 })
    await post({
      event: "embeds",
      params: {
        embeds: [
          { address: EMBEDDED, rect: rect(420), scale: 1 },
          { address: "artifact:art_0000000000#chart=secret", rect: rect(900), scale: 1 },
        ],
      },
    })
    const drawn = () =>
      Array.from(ui.container.querySelectorAll<HTMLElement>("[data-sixb-frame-embed]"))
    expect(drawn().map((element) => element.dataset.sixbFrameEmbed)).toEqual([EMBEDDED])
    expect(drawn()[0]?.style.top).toBe("420px")
    // At the page's own scale, the box is drawn as it is.
    expect((drawn()[0]?.firstElementChild as HTMLElement | null)?.style.transform).toBe("scale(1)")
    // The page scrolled 300px: the frame says where the box is now, and it follows.
    await post({
      event: "embeds",
      params: { embeds: [{ address: EMBEDDED, rect: rect(120), scale: 1 }] },
    })
    expect(drawn()[0]?.style.top).toBe("120px")
  })

  test("pass a wheel turned over them on to the page", async () => {
    // Reproduce by dropping `onScroll` from the page's overlay: over an embed, the page stops.
    const { ui, show, post, posted } = mount()
    await show()
    await post({
      event: "embeds",
      params: {
        embeds: [{ address: EMBEDDED, rect: { x: 0, y: 0, width: 640, height: 360 }, scale: 1 }],
      },
    })
    const embed = ui.container.querySelector("[data-sixb-frame-embed]")
    if (!embed) throw new Error("Expected the embed.")
    await act(async () => {
      fireEvent.wheel(embed, { deltaX: 0, deltaY: 120 })
    })
    expect(
      posted.filter((message) => message.method === "scroll").map((message) => message.params)
    ).toEqual([{ x: 0, y: 120 }])
  })
})

describe("a page in a document", () => {
  function mountInDocument() {
    const version = pageVersion()
    const cache = frameCache(version)
    seedVersion(cache, version, {}, { as: "latest" })
    const ui = render(
      <QueryClientProvider client={cache}>
        <ArtifactReferencesProvider open={() => {}}>
          <ReferencingMarkdown>{`![Fleet planner](artifact:${PAGE})`}</ReferencingMarkdown>
        </ArtifactReferencesProvider>
      </QueryClientProvider>
    )
    const box = ui.container.querySelector<HTMLElement>("[data-sixb-page-embed]")
    if (!box) throw new Error("Expected the page's frame.")
    return { box, ...frameOf(box.querySelector("iframe")) }
  }

  test("runs live, as tall as it lays out, up to 800 pixels", async () => {
    // Reproduce by drawing a page as a card, or by dropping the cap in PageEmbed: no frame, or
    // a page taller than the window.
    const { box, show, post } = mountInDocument()
    expect(box.style.height).toBe("360px")
    await show()
    await post({ event: "size", params: { height: 540 } })
    expect(box.style.height).toBe("540px")
    await post({ event: "size", params: { height: 2400 } })
    expect(box.style.height).toBe("800px")
  })
})
