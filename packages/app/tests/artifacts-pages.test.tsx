import { describe, expect, test } from "bun:test"
import type { GetArtifactVersionResponse } from "@sixb/client"
import { FRAME_PROTOCOL } from "@sixb/core/artifacts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render } from "@testing-library/react"
import { ArtifactReferencesProvider } from "../src/artifacts/references/references"
import { PageRenderer } from "../src/artifacts/renderers/page"
import type { ArtifactTarget } from "../src/artifacts/target"
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
  "EventTarget",
  "MutationObserver",
  "ResizeObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

const PAGE = "art_fl33tpl4n0"
const LINKED = "artifact:art_m3tr1csq3a#chart=sla-trend"

function pageVersion(): GetArtifactVersionResponse {
  return {
    artifactId: PAGE,
    version: 1,
    title: "Fleet planner",
    entry: "index.html",
    files: [],
    outline: { kind: "page", title: "Fleet planner" },
    references: [{ address: LINKED, as: "link", at: "", resolvedVersion: 3 }],
    author: { type: "user", id: "user-1" },
    createdAt: "2026-10-18T12:00:00.000Z",
  }
}

function mount() {
  const version = pageVersion()
  const cache = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
  cache.setQueryData(["artifact-frame", version.artifactId, version.version], {
    path: "/api/artifact-frames/token/",
    expiresAt: "2026-10-18T13:00:00.000Z",
  })
  const opened: ArtifactTarget[] = []
  const ui = render(
    <QueryClientProvider client={cache}>
      <ArtifactReferencesProvider open={(target) => opened.push(target)}>
        <PageRenderer version={version} />
      </ArtifactReferencesProvider>
    </QueryClientProvider>
  )
  const frame = ui.container.querySelector("iframe")
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
  return { frame, posted, post, opened }
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
