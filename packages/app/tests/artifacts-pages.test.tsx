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
    // A page reads rows as its reader: its frame opens no window to take them elsewhere.
    // Reproduce by putting `allow-popups` back on ArtifactFrame's sandbox.
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-modals")
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

describe("a page's web links", () => {
  /** What `window.open` was asked, and the browser's say on whether the reader is acting. */
  function opener(active: boolean | undefined) {
    const opened: unknown[][] = []
    const open = browser.open
    const activation = Object.getOwnPropertyDescriptor(browser.navigator, "userActivation")
    browser.open = ((...args: unknown[]) => {
      opened.push(args)
      return null
    }) as never
    Object.defineProperty(browser.navigator, "userActivation", {
      configurable: true,
      value: active === undefined ? undefined : { isActive: active, hasBeenActive: true },
    })
    const restore = () => {
      browser.open = open
      if (activation) Object.defineProperty(browser.navigator, "userActivation", activation)
      else Reflect.deleteProperty(browser.navigator, "userActivation")
    }
    return { opened, restore }
  }

  const link = { event: "link", params: { url: "https://example.com/fleet?region=north" } }

  test("open in a new tab that knows nothing of the app, as the reader follows one", async () => {
    const { opened, restore } = opener(true)
    try {
      const { frame, post } = mount()
      frame.focus()
      await post(link)
      expect(opened).toEqual([
        ["https://example.com/fleet?region=north", "_blank", "noopener,noreferrer"],
      ])
    } finally {
      restore()
    }
  })

  test("open nothing the reader did not just do in the frame", async () => {
    // The page's code posts what it likes, so the app asks the browser: a link opens only while
    // the frame holds the focus, and the reader has just clicked or typed. Reproduce by dropping
    // either check from openWebLink in ArtifactFrame: the first case below, or the second, opens.
    const elsewhere = opener(true)
    try {
      // The reader clicked the app, outside the frame.
      await mount().post(link)
      expect(elsewhere.opened).toEqual([])
    } finally {
      elsewhere.restore()
    }

    const idle = opener(false)
    try {
      // Focus stays in the frame after a click, long after the moment it allowed.
      const { frame, post } = mount()
      frame.focus()
      await post(link)
      expect(idle.opened).toEqual([])
    } finally {
      idle.restore()
    }

    const acting = opener(true)
    try {
      // And only a web page, whatever the reader does: the protocol drops any other address.
      const { frame, post } = mount()
      frame.focus()
      await post({ event: "link", params: { url: "javascript:alert(document.cookie)" } })
      expect(acting.opened).toEqual([])
    } finally {
      acting.restore()
    }
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
          { id: 1, address: EMBEDDED, rect: rect(420), scale: 1 },
          { id: 2, address: "artifact:art_0000000000#chart=secret", rect: rect(900), scale: 1 },
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
      params: { embeds: [{ id: 1, address: EMBEDDED, rect: rect(120), scale: 1 }] },
    })
    expect(drawn()[0]?.style.top).toBe("120px")
  })

  test("stay mounted while the ones before them scroll out of reach", async () => {
    // Reproduce by keying FrameEmbeds by rank among the embeds reported: once the first one goes,
    // every one after it mounts again, and an embedded page loads in a new frame.
    const calculator = { ...pageVersion(), artifactId: "art_ca1c4at0rs", title: "Calculator" }
    const version = {
      ...pageVersion(),
      references: [
        ...pageVersion().references,
        {
          address: `artifact:${calculator.artifactId}`,
          as: "embed" as const,
          at: "",
          resolvedVersion: 1,
        },
      ],
    }
    const cache = frameCache(version)
    seedVersion(cache, calculator, {}, { as: "latest" })
    cache.setQueryData(["artifact-frame", calculator.artifactId, 1], {
      path: "/api/artifact-frames/calculator/",
      expiresAt: "2026-10-18T13:00:00.000Z",
    })
    const ui = render(
      <QueryClientProvider client={cache}>
        <ArtifactReferencesProvider open={() => {}}>
          <PageRenderer version={version} />
        </ArtifactReferencesProvider>
      </QueryClientProvider>
    )
    const { show, post } = frameOf(ui.container.querySelector("iframe"))
    await show()

    // The chart twice, then the calculator, as the page lays them out.
    const rect = (y: number) => ({ x: 32, y, width: 640, height: 360 })
    const embed = (id: number, address: string, y: number) => ({
      id,
      address,
      rect: rect(y),
      scale: 1,
    })
    const page = `artifact:${calculator.artifactId}`
    await post({
      event: "embeds",
      params: {
        embeds: [embed(1, EMBEDDED, 0), embed(2, EMBEDDED, 400), embed(3, page, 800)],
      },
    })
    const drawn = () =>
      Array.from(ui.container.querySelectorAll<HTMLElement>("[data-sixb-frame-embed]"))
    const [, chart, calculatorBox] = drawn()
    const calculatorFrame = calculatorBox?.querySelector("iframe")
    expect(calculatorFrame?.getAttribute("src")).toContain("/api/artifact-frames/calculator/")

    // The reader scrolls down: the first chart is more than a screen above, and no longer reported.
    await post({
      event: "embeds",
      params: { embeds: [embed(2, EMBEDDED, -800), embed(3, page, -400)] },
    })

    // The same elements, not new ones drawn alike: the calculator's frame did not load again.
    const [chartNow, calculatorNow] = drawn()
    expect(chartNow).toBe(chart as HTMLElement)
    expect(calculatorNow).toBe(calculatorBox as HTMLElement)
    expect(calculatorNow?.querySelector("iframe")).toBe(calculatorFrame as HTMLIFrameElement)
  })

  test("pass a wheel turned over them on to the page", async () => {
    // Reproduce by dropping `onScroll` from the page's overlay: over an embed, the page stops.
    const { ui, show, post, posted } = mount()
    await show()
    await post({
      event: "embeds",
      params: {
        embeds: [
          { id: 1, address: EMBEDDED, rect: { x: 0, y: 0, width: 640, height: 360 }, scale: 1 },
        ],
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
