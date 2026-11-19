import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { client } from "@sixb/client"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  TooltipProvider,
} from "@sixb/ui/components"
import { LocaleProvider } from "@sixb/ui/lib/i18n"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, waitFor } from "@testing-library/react"
import { type ReactNode, useLayoutEffect, useState } from "react"
import { ArtifactPreview } from "../src/artifacts/card-preview"
import type { ArtifactVersion } from "../src/artifacts/queries"
import { ChaptersPanel } from "../src/artifacts/renderers/video/chapters"
import { VideoExportEntries, VideoExportMenu } from "../src/artifacts/renderers/video/export"
import { useVideoExport, videoExportView } from "../src/artifacts/renderers/video/export-state"
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
        const answer = answers(version, url.searchParams)
        return answer instanceof Response ? answer : Response.json(answer)
      },
      { preconnect: fetch.preconnect }
    ),
  })
  return asked
}

function Wrap({ children }: { readonly children: ReactNode }) {
  // One cache for the test, as the app keeps: rendering again keeps what it read.
  const [cache] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }))
  return (
    <QueryClientProvider client={cache}>
      <LocaleProvider>
        <TooltipProvider>{children}</TooltipProvider>
      </LocaleProvider>
    </QueryClientProvider>
  )
}

/** The header's MP4 button, reading its export as the header does. */
function ExportButton({ version }: { readonly version: ArtifactVersion }) {
  return <VideoExportMenu version={version} exported={useVideoExport(version)} />
}

/** The MP4 folded into More, as a phone's header has it. */
function FoldedMore({ version }: { readonly version: ArtifactVersion }) {
  const exported = useVideoExport(version)
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger data-testid="more">More</DropdownMenuTrigger>
      <DropdownMenuContent>
        <VideoExportEntries version={version} exported={exported} keepOpen />
      </DropdownMenuContent>
    </DropdownMenu>
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
    // Parts rendered for another version, as an edit of one scene keeps the others: still idle.
    // Reproduce by reading parts rendered as someone asking: the header then shows a render nobody
    // asked for, with no way to start it.
    expect(videoExportView(rendering(1) as never, false)).toEqual({ state: "idle" })
    expect(videoExportView(rendering(3, true) as never, false)).toEqual({ state: "idle" })
    expect(videoExportView(rendering(1) as never, true)).toMatchObject({
      state: "rendering",
      ready: 1,
    })
    expect(videoExportView(rendering(3, true) as never, true)).toMatchObject({ assembling: true })
  })

  // Reproduce by giving a ready export the menu too: downloading it takes a second click.
  test("downloads the MP4 at once once it is rendered", async () => {
    serve(() => ({ status: "ready", durationMs: 7000, sizeBytes: 12_400_000 }))
    const view = render(
      <Wrap>
        <ExportButton version={FILM} />
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
        <ExportButton version={FILM} />
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

  // Reproduce by reading a failed answer as failed in videoExportView whether or not it was asked
  // for here: a failure kept from before shows its warning in the header for good.
  test("reads a failure kept from before as idle, and exporting it asks again", async () => {
    const asked = serve((_version, query) =>
      query.get("retry") === "true"
        ? rendering(0)
        : { status: "failed", reason: "Scene 'outro' could not be rendered." }
    )
    const view = render(
      <Wrap>
        <ExportButton version={FILM} />
      </Wrap>
    )
    const trigger = await waitFor(() => {
      const found = view.container.querySelector("[data-video-export='idle']")
      if (!found) throw new Error("Not read yet.")
      return found
    })
    await open(trigger)
    await act(async () => {
      fireEvent.click(view.getByText("Export MP4"))
    })
    expect(asked).toContain("POST /api/artifacts/art_v1de0f17m0/versions/3/video?retry=true")
    await waitFor(() =>
      expect(view.container.querySelector("[data-video-export='rendering']")).not.toBeNull()
    )
  })

  // Reproduce by showing the answer's reason in StatusLine: the reader reads a developer's words.
  test("says it failed in plain words once asked, and tries again with retry", async () => {
    let started = false
    const asked = serve((_version, query) => {
      if (query.get("render") === "false" && !started) return rendering(0)
      started = true
      return query.get("retry") === "true"
        ? rendering(1)
        : { status: "failed", reason: "Scene 'outro' could not be rendered." }
    })
    const view = render(
      <Wrap>
        <ExportButton version={FILM} />
      </Wrap>
    )
    const trigger = await waitFor(() => {
      const found = view.container.querySelector("[data-video-export='idle']")
      if (!found) throw new Error("Not read yet.")
      return found
    })
    await open(trigger)
    await act(async () => {
      fireEvent.click(view.getByText("Export MP4"))
    })
    const failed = await waitFor(() => {
      const found = view.container.querySelector("[data-video-export='failed']")
      if (!found) throw new Error("Not failed yet.")
      return found
    })

    await open(failed)
    await view.findByText("Something went wrong while rendering it.")
    expect(view.queryByText("Scene 'outro' could not be rendered.")).toBeNull()
    await act(async () => {
      fireEvent.click(view.getByText("Try again"))
    })
    expect(asked).toContain("POST /api/artifacts/art_v1de0f17m0/versions/3/video?retry=true")
    await waitFor(() =>
      expect(view.container.querySelector("[data-video-export='rendering']")).not.toBeNull()
    )
  })

  // Reproduce by reading `lacks` as any failure in videoExportView: the header offers a retry
  // that fails the same, in red, until the project's sandboxes have HyperFrames.
  test("says export is not available, with no retry, when the project cannot render", async () => {
    serve((_version, query) =>
      query.get("render") === "false"
        ? rendering(0)
        : { status: "failed", reason: "No HyperFrames.", lacks: "sandbox_tools" }
    )
    const view = render(
      <Wrap>
        <ExportButton version={FILM} />
      </Wrap>
    )
    const trigger = await waitFor(() => {
      const found = view.container.querySelector("[data-video-export='idle']")
      if (!found) throw new Error("Not read yet.")
      return found
    })
    await open(trigger)
    await act(async () => {
      fireEvent.click(view.getByText("Export MP4"))
    })
    const unavailable = await waitFor(() => {
      const found = view.container.querySelector("[data-video-export='unavailable']")
      if (!found) throw new Error("Not answered yet.")
      return found
    })
    expect(unavailable.getAttribute("aria-label")).toBe("MP4 export isn’t available")

    await open(unavailable)
    await view.findByText(/isn’t set up to render videos/)
    expect(view.queryAllByRole("menuitem")).toHaveLength(0)

    // A write makes another video: the header offers to export it.
    view.rerender(
      <Wrap>
        <ExportButton version={{ ...FILM, revision: 2 }} />
      </Wrap>
    )
    await waitFor(() =>
      expect(view.container.querySelector("[data-video-export='idle']")).not.toBeNull()
    )
  })

  // Reproduce by dropping the video_unavailable catch in useVideoExport: Export does nothing.
  test("says export is not available when the project has no sandboxes", async () => {
    serve((_version, query) =>
      query.get("render") === "false"
        ? rendering(0)
        : Response.json(
            { error: "No sandbox provider.", code: "video_unavailable" },
            { status: 400 }
          )
    )
    const view = render(
      <Wrap>
        <ExportButton version={FILM} />
      </Wrap>
    )
    const trigger = await waitFor(() => {
      const found = view.container.querySelector("[data-video-export='idle']")
      if (!found) throw new Error("Not read yet.")
      return found
    })
    await open(trigger)
    await act(async () => {
      fireEvent.click(view.getByText("Export MP4"))
    })
    await waitFor(() =>
      expect(view.container.querySelector("[data-video-export='unavailable']")).not.toBeNull()
    )
  })

  // Reproduce by leaving the revision out of videoExportQueryKey: the header keeps offering the
  // MP4 of what the version held before, which the server no longer has.
  test("reads a version's MP4 anew once a write changes it", async () => {
    let revision = 1
    const asked = serve(() =>
      revision === 1 ? { status: "ready", durationMs: 7000, sizeBytes: 12_400_000 } : rendering(2)
    )
    const view = render(
      <Wrap>
        <ExportButton version={FILM} />
      </Wrap>
    )
    await waitFor(() =>
      expect(view.container.querySelector("[data-video-export='ready']")).not.toBeNull()
    )

    revision = 2
    view.rerender(
      <Wrap>
        <ExportButton version={{ ...FILM, revision: 2 }} />
      </Wrap>
    )
    await waitFor(() =>
      expect(view.container.querySelector("[data-video-export='idle']")).not.toBeNull()
    )
    expect(asked.filter((each) => each.includes("/versions/3/"))).toHaveLength(2)
    // Idle, it reads the version before it, as any version not exported does.
    await waitFor(() => expect(asked.at(-1)).toContain("/versions/2/video?render=false"))
  })

  // Reproduce by leaving the revision out of useVideoExport's `exported`: a write to the version
  // being rendered asks to render what it holds now, unasked, and shows it rendering.
  test("an export asked for before a write is not asked for what the write made", async () => {
    let started = false
    const asked = serve(() => rendering(started ? 1 : 0))
    const view = render(
      <Wrap>
        <ExportButton version={FILM} />
      </Wrap>
    )
    const trigger = await waitFor(() => {
      const found = view.container.querySelector("[data-video-export='idle']")
      if (!found) throw new Error("Not read yet.")
      return found
    })
    await open(trigger)
    const [exportItem] = await view.findAllByRole("menuitem")
    started = true
    await act(async () => {
      if (exportItem) fireEvent.click(exportItem)
    })
    await waitFor(() =>
      expect(view.container.querySelector("[data-video-export='rendering']")).not.toBeNull()
    )

    view.rerender(
      <Wrap>
        <ExportButton version={{ ...FILM, revision: 2 }} />
      </Wrap>
    )
    await waitFor(() =>
      expect(view.container.querySelector("[data-video-export='idle']")).not.toBeNull()
    )
    expect(asked.at(-1)).toBe("POST /api/artifacts/art_v1de0f17m0/versions/3/video?render=false")
  })

  // Reproduce by leaving `earlier` out of useVideoExport: a new version hides the MP4 there was.
  test("offers the version before it, out of date, while this one is not exported", async () => {
    const asked = serve((version) =>
      version === "2" ? { status: "ready", durationMs: 6000, sizeBytes: 9_000_000 } : rendering(0)
    )
    const view = render(
      <Wrap>
        <ExportButton version={FILM} />
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

  // Reproduce by dropping keepOpen's preventDefault in VideoExportEntries: More closes on Export,
  // and a phone's reader sees nothing render, More's button showing no more than its ring.
  test("folded into More, exporting keeps the menu open on how far it has rendered", async () => {
    let started = false
    serve((_version, query) =>
      query.get("render") === "false" && !started ? rendering(0) : rendering(started ? 1 : 0)
    )
    const view = render(
      <Wrap>
        <FoldedMore version={FILM} />
      </Wrap>
    )
    await open(view.getByTestId("more"))
    started = true
    await act(async () => {
      fireEvent.click(await view.findByText("Export MP4"))
    })
    await view.findByRole("progressbar")
    await view.findByText("Rendering · 1 of 3 parts")
  })

  // Reproduce by leaving a ready answer to VideoExportEntries' other entries: More then names the
  // MP4 with no way to download it.
  test("folded into More, a rendered MP4 is one entry that downloads it", async () => {
    serve(() => ({ status: "ready", durationMs: 7000, sizeBytes: 12_400_000 }))
    const view = render(
      <Wrap>
        <FoldedMore version={FILM} />
      </Wrap>
    )
    await open(view.getByTestId("more"))
    const entry = await view.findByRole("menuitem")
    expect(entry.textContent).toContain("Download MP4")
    expect(entry.textContent).toContain("0:07 · 12 MB")
    expect(entry.getAttribute("href")).toEndWith("/versions/3/video")
    expect(entry.getAttribute("download")).toBe("Launch film.mp4")
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

  // Reproduce by dropping the recording's poster from VideoPreview: until its stills are
  // snapshotted, or in a project that snapshots nothing, every video's card is the same dark tile.
  test("its card shows its first recording's poster until it is snapshotted", async () => {
    const poster =
      "/api/artifacts/art_v1de0f17m0/versions/3/media/content?path=media/b-roll.mp4&part=poster"
    const asked: string[] = []
    client.setConfig({
      baseUrl: "https://api.sixb.test",
      fetch: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(new Request(input, init).url)
          asked.push(`${url.pathname}${url.search}`)
          const ready = { status: "ready", url: poster, mediaType: "image/jpeg", sizeBytes: 9 }
          return Response.json({
            path: url.searchParams.get("path"),
            version: 3,
            parts: { proxy: { status: "pending" }, poster: { ...ready, atMs: 1200 } },
          })
        },
        { preconnect: fetch.preconnect }
      ),
    })
    const media = (path: string, mediaType: string, index: number) => ({
      path,
      file: {
        blobId: `clip-${index}`,
        digest: `sha256:${"c".repeat(63)}${index}`,
        sizeBytes: 9,
        mediaType,
      },
    })
    const film = {
      ...FILM,
      files: [
        ...FILM.files,
        media("media/a-voice.m4a", "audio/mp4", 1),
        media("media/b-roll.mp4", "video/mp4", 2),
      ],
    }
    const view = render(
      <Wrap>
        <ArtifactPreview version={film} kind="video" loading={false} />
      </Wrap>
    )
    // Its poster is read first: no recording is asked about while it may come.
    expect(asked).toEqual([])
    act(() => {
      view.container.querySelector("img")?.dispatchEvent(new Event("error"))
    })

    const fallback = await waitFor(() => {
      const found = view.container.querySelector<HTMLImageElement>("img")
      if (!found?.getAttribute("src")?.includes("part=poster")) throw new Error("Not read yet.")
      return found
    })
    expect(asked).toEqual([
      "/api/artifacts/art_v1de0f17m0/versions/3/media?path=media%2Fb-roll.mp4",
    ])
    expect(fallback.getAttribute("src")).toBe(
      "https://api.sixb.test/api/artifacts/art_v1de0f17m0/versions/3/media/content?path=media%2Fb-roll.mp4&part=poster"
    )
    act(() => {
      fallback.dispatchEvent(new Event("load"))
    })
    expect(fallback.className).toContain("sixb-media-in")
  })

  // Reproduce by dropping `poster` from ChapterMark: a chapter not snapshotted shows its number.
  test("a chapter not snapshotted yet shows its first recording's poster", () => {
    const view = render(
      <Wrap>
        <ChaptersPanel
          outline={OUTLINE}
          still={(scene) => `https://stills.test/${scene.id}.jpg`}
          poster="https://media.test/b-roll.jpg"
          current="intro"
          onSeek={() => {}}
          onClose={() => {}}
        />
      </Wrap>
    )
    const [intro] = view.container.querySelectorAll("img.hidden")
    act(() => {
      intro?.dispatchEvent(new Event("error"))
    })
    const hidden = [...view.container.querySelectorAll("img.hidden")]
    expect(hidden.map((image) => image.getAttribute("src"))).toEqual([
      "https://media.test/b-roll.jpg",
      "https://stills.test/outro.jpg",
    ])
    act(() => {
      hidden[0]?.dispatchEvent(new Event("load"))
    })
    const shown = view.container.querySelector("img.sixb-media-in")
    expect(shown?.getAttribute("src")).toBe("https://media.test/b-roll.jpg")
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
