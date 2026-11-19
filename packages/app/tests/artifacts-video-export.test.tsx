import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { client } from "@sixb/client"
import { TooltipProvider } from "@sixb/ui/components"
import { LocaleProvider } from "@sixb/ui/lib/i18n"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, waitFor } from "@testing-library/react"
import { type ReactNode, useLayoutEffect } from "react"
import { ArtifactPreview } from "../src/artifacts/card-preview"
import { ChaptersPanel } from "../src/artifacts/renderers/video/chapters"
import { VideoExportMenu } from "../src/artifacts/renderers/video/export"
import { videoExportView } from "../src/artifacts/renderers/video/export-state"
import { artifactVersion, textFiles } from "./helpers/artifacts"
import { installDom } from "./helpers/dom"

installDom([
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLImageElement",
  "SVGElement",
  "FocusEvent",
  "CustomEvent",
  "matchMedia",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "EventTarget",
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

// Radix picks its layout effect when it loads, a no-op without a `document`, and its menus then
// never mount. It is given React's own for this file, and its own back after.
const radix = Bun.resolveSync("radix-ui", Bun.resolveSync("@sixb/ui/components", import.meta.dir))
const layoutEffect = Bun.resolveSync(
  "@radix-ui/react-use-layout-effect",
  Bun.resolveSync("@radix-ui/react-portal", Bun.resolveSync("@radix-ui/react-dialog", radix))
)
const loaded: typeof useLayoutEffect = (await import(layoutEffect)).useLayoutEffect
mock.module(layoutEffect, () => ({ useLayoutEffect }))
afterAll(() => {
  mock.module(layoutEffect, () => ({ useLayoutEffect: loaded }))
})

// A video's MP4 in its header, its poster on its card, and its scenes' stills in its chapters.

const FILM = artifactVersion({
  artifactId: "art_v1de0f17m0",
  version: 3,
  title: "Launch film",
  entry: "index.html",
  files: textFiles({ "index.html": "<div></div>" }),
  outline: {
    kind: "video",
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 7000,
    scenes: [
      { id: "intro", label: "Opening", startMs: 0, durationMs: 2000, renderKey: "a" },
      { id: "outro", label: "Thanks", startMs: 2000, durationMs: 5000, renderKey: "b" },
    ],
  },
})
const OUTLINE = FILM.outline.kind === "video" ? FILM.outline : null
if (!OUTLINE) throw new Error("Expected a video.")

const originalConfig = client.getConfig()
afterEach(() => client.setConfig({ fetch: originalConfig.fetch }))
afterAll(() => client.setConfig({ baseUrl: originalConfig.baseUrl }))

const rendering = (ready: number, assembling = false) => ({
  status: "rendering",
  progress: { ready, total: 3, assembling },
})

/** The API, answering each version's export as `answers` says, and keeping what was asked. */
function serve(answers: (version: string, query: URLSearchParams) => unknown) {
  const asked: string[] = []
  client.setConfig({
    baseUrl: "https://api.sixb.test",
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        asked.push(`${request.method} ${url.pathname}${url.search}`)
        const version = url.pathname.split("/").at(-2) ?? ""
        return Response.json(answers(version, url.searchParams))
      },
      { preconnect: fetch.preconnect }
    ),
  })
  return asked
}

function Wrap({ children }: { readonly children: ReactNode }) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={cache}>
      <LocaleProvider>
        <TooltipProvider>{children}</TooltipProvider>
      </LocaleProvider>
    </QueryClientProvider>
  )
}

const open = async (trigger: Element) => {
  await act(async () => {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" })
  })
}

describe("a video's MP4 in its header", () => {
  test("reads an answer nobody asked for as idle, and one asked for as rendering", () => {
    expect(videoExportView(undefined, false)).toEqual({ state: "loading" })
    expect(videoExportView(rendering(0) as never, false)).toEqual({ state: "idle" })
    expect(videoExportView(rendering(0) as never, false, 2)).toEqual({ state: "idle", earlier: 2 })
    expect(videoExportView(rendering(0) as never, true)).toMatchObject({ state: "rendering" })
    // Parts rendered: someone asked, here or elsewhere.
    expect(videoExportView(rendering(1) as never, false)).toMatchObject({
      state: "rendering",
      ready: 1,
    })
    expect(videoExportView(rendering(3, true) as never, false)).toMatchObject({ assembling: true })
  })

  // Reproduce by giving a ready export the menu too: downloading it takes a second click.
  test("downloads the MP4 at once once it is rendered", async () => {
    serve(() => ({ status: "ready", durationMs: 7000, sizeBytes: 12_400_000 }))
    const view = render(
      <Wrap>
        <VideoExportMenu version={FILM} />
      </Wrap>
    )
    const link = await waitFor(() => {
      const found = view.container.querySelector<HTMLAnchorElement>("[data-video-export='ready']")
      if (!found) throw new Error("Not ready yet.")
      return found
    })
    expect(link.getAttribute("href")).toBe(
      "https://api.sixb.test/api/artifacts/art_v1de0f17m0/versions/3/video"
    )
    expect(link.getAttribute("download")).toBe("Launch film.mp4")
    expect(link.getAttribute("aria-label")).toBe("Download MP4, MP4 · 0:07 · 12 MB")
  })

  // Reproduce by asking with render in the first read of useVideoExport: opening a video renders it.
  test("exports when asked, then shows how far it has rendered", async () => {
    let started = false
    const asked = serve((_version, query) =>
      query.get("render") === "false" && !started ? rendering(0) : rendering(started ? 1 : 0)
    )
    const view = render(
      <Wrap>
        <VideoExportMenu version={FILM} />
      </Wrap>
    )
    const trigger = await waitFor(() => {
      const found = view.container.querySelector("[data-video-export='idle']")
      if (!found) throw new Error("Not read yet.")
      return found
    })
    expect(asked).toEqual([
      "POST /api/artifacts/art_v1de0f17m0/versions/3/video?render=false",
      expect.stringContaining("/versions/2/video?render=false"),
    ])

    await open(trigger)
    const [exportItem] = await view.findAllByRole("menuitem")
    expect(exportItem?.textContent).toContain("Renders each scene")
    started = true
    await act(async () => {
      if (exportItem) fireEvent.click(exportItem)
    })
    await waitFor(() =>
      expect(view.container.querySelector("[data-video-export='rendering']")).not.toBeNull()
    )
    expect(asked).toContain("POST /api/artifacts/art_v1de0f17m0/versions/3/video")
    expect(
      view.container.querySelector("[data-video-export='rendering']")?.getAttribute("aria-label")
    ).toBe("Rendering the MP4, 1 of 3 parts done")
  })

  test("says why it failed, and tries again with retry", async () => {
    let retried = false
    const asked = serve((_version, query) => {
      if (query.get("retry") === "true") retried = true
      return retried
        ? rendering(0)
        : { status: "failed", reason: "Scene 'outro' could not be rendered." }
    })
    const view = render(
      <Wrap>
        <VideoExportMenu version={FILM} />
      </Wrap>
    )
    const trigger = await waitFor(() => {
      const found = view.container.querySelector("[data-video-export='failed']")
      if (!found) throw new Error("Not read yet.")
      return found
    })
    await open(trigger)
    await view.findByText("Scene 'outro' could not be rendered.")
    await act(async () => {
      fireEvent.click(view.getByText("Try again"))
    })
    expect(asked).toContain("POST /api/artifacts/art_v1de0f17m0/versions/3/video?retry=true")
    await waitFor(() =>
      expect(view.container.querySelector("[data-video-export='rendering']")).not.toBeNull()
    )
  })

  // Reproduce by leaving `earlier` out of useVideoExport: a new version hides the MP4 there was.
  test("offers the version before it, out of date, while this one is not exported", async () => {
    const asked = serve((version) =>
      version === "2" ? { status: "ready", durationMs: 6000, sizeBytes: 9_000_000 } : rendering(0)
    )
    const view = render(
      <Wrap>
        <VideoExportMenu version={FILM} />
      </Wrap>
    )
    const trigger = await waitFor(() => {
      const found = view.container.querySelector("[data-video-export='idle']")
      if (!found) throw new Error("Not read yet.")
      return found
    })
    // The version before is read once this one says it is idle.
    await waitFor(() =>
      expect(asked).toContain("POST /api/artifacts/art_v1de0f17m0/versions/2/video?render=false")
    )
    await open(trigger)
    await view.findByText("Download version 2")
    const earlier = view.getByText("Download version 2").closest("a")
    expect(earlier?.getAttribute("href")).toEndWith("/versions/2/video")
    expect(view.getByText("Earlier version · out of date")).not.toBeNull()
  })
})

describe("a video's pictures", () => {
  // Reproduce by leaving the poster's <img> out of VideoPreview: the card stays a dark screen.
  test("its card shows its poster once loaded, and its dark screen when there is none", () => {
    client.setConfig({ baseUrl: "https://api.sixb.test" })
    const view = render(
      <Wrap>
        <ArtifactPreview version={FILM} kind="video" loading={false} />
      </Wrap>
    )
    const poster = view.container.querySelector("img")
    expect(poster?.getAttribute("src")).toBe(
      "https://api.sixb.test/api/artifacts/art_v1de0f17m0/versions/3/poster"
    )
    act(() => {
      poster?.dispatchEvent(new Event("load"))
    })
    expect(poster?.className).toContain("sixb-media-in")

    act(() => {
      poster?.dispatchEvent(new Event("error"))
    })
    expect(view.container.querySelector("img")).toBeNull()
  })

  test("each chapter shows its scene's still once it has loaded, its number until then", () => {
    const view = render(
      <Wrap>
        <ChaptersPanel
          outline={OUTLINE}
          still={(scene) => `https://stills.test/${scene.id}.jpg`}
          current="intro"
          onSeek={() => {}}
          onClose={() => {}}
        />
      </Wrap>
    )
    const hidden = [...view.container.querySelectorAll("img.hidden")]
    expect(hidden.map((image) => image.getAttribute("src"))).toEqual([
      "https://stills.test/intro.jpg",
      "https://stills.test/outro.jpg",
    ])
    act(() => {
      hidden[1]?.dispatchEvent(new Event("load"))
    })
    const shown = view.container.querySelector("img.sixb-media-in")
    expect(shown?.getAttribute("src")).toBe("https://stills.test/outro.jpg")
    expect(view.container.querySelectorAll("img.hidden")).toHaveLength(1)
  })
})
