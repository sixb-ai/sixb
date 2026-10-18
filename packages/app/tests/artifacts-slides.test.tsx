import { describe, expect, jest, test } from "bun:test"
import type { GetArtifactVersionResponse } from "@sixb/client"
import { type DeckMode, FRAME_PROTOCOL, type FrameEvent } from "@sixb/core/artifacts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render } from "@testing-library/react"
import { createRef } from "react"
import { DECK_KEYS } from "../../core/src/artifacts/frames/protocol"
import { leaveEscapeToDeck } from "../src/agent/artifact-panel"
import { artifactFileSource } from "../src/artifacts/file-source"
import { ArtifactFrame, type ArtifactFrameHandle } from "../src/artifacts/frame"
import { ArtifactReferencesProvider } from "../src/artifacts/references/references"
import { deckKeyAction, slideFromPart } from "../src/artifacts/renderers/slides/navigation"
import { SlidesRenderer } from "../src/artifacts/renderers/slides/slides"
import type { ArtifactTarget } from "../src/artifacts/target"
import { installDom } from "./helpers/dom"

describe("moving through a deck", () => {
  const at = (slide: number, mode: DeckMode = "slide") => ({ slide, total: 6, mode })

  test("steps with the arrows, jumps with Home and End, and stays inside the deck", () => {
    expect(deckKeyAction("ArrowRight", at(2))).toEqual({ type: "goto", slide: 3 })
    expect(deckKeyAction(" ", at(2))).toEqual({ type: "goto", slide: 3 })
    expect(deckKeyAction("ArrowLeft", at(2))).toEqual({ type: "goto", slide: 1 })
    expect(deckKeyAction("ArrowRight", at(6))).toEqual({ type: "goto", slide: 6 })
    expect(deckKeyAction("ArrowLeft", at(1))).toEqual({ type: "goto", slide: 1 })
    expect(deckKeyAction("End", at(2))).toEqual({ type: "goto", slide: 6 })
    expect(deckKeyAction("Home", at(5))).toEqual({ type: "goto", slide: 1 })
    expect(deckKeyAction("Escape", at(3, "overview"))).toEqual({ type: "mode", mode: "slide" })
    expect(deckKeyAction("Escape", at(3, "present"))).toEqual({ type: "mode", mode: "slide" })
    expect(deckKeyAction("Escape", at(3))).toBeNull()
    expect(deckKeyAction("x", at(3))).toBeNull()
  })

  test("does something with every key the frame passes on", () => {
    // Reproduce by adding a key to DECK_KEYS that deckKeyAction does not handle: the frame would
    // swallow it from the deck's page and the app would do nothing with it.
    for (const key of DECK_KEYS) {
      const modes: DeckMode[] = ["slide", "overview", "present"]
      expect(modes.some((mode) => deckKeyAction(key, at(3, mode)) !== null)).toBe(true)
    }
  })

  test("opens at the slide an address names, within the deck", () => {
    expect(slideFromPart("4", 6)).toBe(4)
    expect(slideFromPart("9", 6)).toBe(6)
    expect(slideFromPart(undefined, 6)).toBe(1)
    expect(slideFromPart("intro", 6)).toBe(1)
  })
})

const browser = installDom([
  "document",
  "navigator",
  "localStorage",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLIFrameElement",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "MessageEvent",
  "EventTarget",
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

const DECK = "art_q3dec4000"
const LINKED = "artifact:art_m3tr1csq3a#chart=sla-trend"

function deckVersion(
  input: {
    readonly slides?: number
    readonly references?: GetArtifactVersionResponse["references"]
    readonly files?: GetArtifactVersionResponse["files"]
  } = {}
): GetArtifactVersionResponse {
  return {
    artifactId: DECK,
    version: 1,
    title: "Q3 review",
    entry: "index.html",
    files: input.files ?? [],
    outline: {
      kind: "slides",
      slides: Array.from({ length: input.slides ?? 1 }, (_, index) => ({
        title: `Slide ${index + 1}`,
      })),
    },
    references: input.references ?? [],
    author: { type: "user", id: "user-1" },
    createdAt: "2026-10-17T12:00:00.000Z",
  }
}

/** A cache that reads nothing itself, with the deck's frame link minted already. */
function frameCache(version: GetArtifactVersionResponse, token = "token"): QueryClient {
  const cache = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
  cache.setQueryData(["artifact-frame", version.artifactId, version.version], {
    path: `/api/artifact-frames/${token}/`,
    expiresAt: "2026-10-17T13:00:00.000Z",
  })
  return cache
}

/** Changes the cache, and lets its observers hear of it: the query cache tells them on a timer. */
async function changeCache(change: () => void): Promise<void> {
  await act(async () => {
    change()
    await Bun.sleep(5)
  })
}

/** What the app posted to a frame, and a way to post as the frame. */
function frameOf(element: Element | null | undefined) {
  const target = element?.tagName === "IFRAME" ? (element as HTMLIFrameElement).contentWindow : null
  if (!target) throw new Error("Expected a loaded frame.")
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
  return {
    element,
    posted,
    /** The requests the app has made, as `method` and `params`. */
    requests: () => posted.map(({ method, params }) => ({ method, params })),
    post,
    /** Says it is ready, and answers the theme the app sends then. */
    ready: async (slides = 1) => {
      await post({ event: "ready", params: { slides } })
      const theme = posted.filter((message) => message.method === "theme").at(-1)
      if (theme) await post({ id: theme.id })
    },
  }
}

function Deck({
  cache,
  version,
  open = () => {},
}: {
  readonly cache: QueryClient
  readonly version: GetArtifactVersionResponse
  readonly open?: (target: ArtifactTarget) => void
}) {
  return (
    <QueryClientProvider client={cache}>
      <ArtifactReferencesProvider open={open}>
        <SlidesRenderer version={version} />
      </ArtifactReferencesProvider>
    </QueryClientProvider>
  )
}

describe("a deck's frame", () => {
  test("is sandboxed without the app's origin, and hears only its own frame", async () => {
    // Reproduce by dropping the `event.source` check in ArtifactFrame: another window's message
    // reaches the deck as if its frame had sent it.
    const version = deckVersion()
    const events: FrameEvent[] = []
    const ui = render(
      <QueryClientProvider client={frameCache(version)}>
        <ArtifactFrame
          version={version}
          title="Q3 review"
          onEvent={(event) => events.push(event)}
        />
      </QueryClientProvider>
    )
    const frame = ui.container.querySelector("iframe")
    expect(frame?.getAttribute("sandbox")).toBe(
      "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals"
    )
    expect(frame?.getAttribute("src")).toEndWith("/api/artifact-frames/token/index.html")
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer")

    const ready = { protocol: FRAME_PROTOCOL, event: "ready", params: { slides: 1 } }
    // Hidden until its theme is applied: a deck paints the kit's light defaults until then.
    expect(frame?.className).toContain("opacity-0")
    const other = ui.container.ownerDocument.createElement("iframe")
    ui.container.append(other)
    await act(async () => {
      browser.dispatchEvent(
        new browser.MessageEvent("message", { data: ready, source: other.contentWindow as never })
      )
    })
    expect(events).toEqual([])
    await act(async () => {
      browser.dispatchEvent(
        new browser.MessageEvent("message", { data: ready, source: frame?.contentWindow as never })
      )
    })
    expect(events).toEqual([ready as FrameEvent])
    // Ready, the app sends the theme (request 1); once the frame answers, it shows. Reproduce by
    // showing the frame without waiting for the theme in ArtifactFrame.
    expect(frame?.className).toContain("opacity-0")
    await act(async () => {
      browser.dispatchEvent(
        new browser.MessageEvent("message", {
          data: { protocol: FRAME_PROTOCOL, id: 1 },
          source: frame?.contentWindow as never,
        })
      )
    })
    expect(ui.container.querySelector("iframe")?.className).toContain("opacity-100")
  })

  test("keeps the link it first loaded when a later one is minted", async () => {
    // Reproduce by building the source from `frame.data` in ArtifactFrame: the new link reloads
    // the mounted frame, which opens at its start again.
    const version = deckVersion()
    const cache = frameCache(version, "first")
    const ui = render(
      <QueryClientProvider client={cache}>
        <ArtifactFrame version={version} title="Q3 review" />
      </QueryClientProvider>
    )
    const source = () => ui.container.querySelector("iframe")?.getAttribute("src")
    expect(source()).toContain("/first/")
    await changeCache(() => {
      cache.setQueryData(["artifact-frame", DECK, 1], {
        path: "/api/artifact-frames/second/",
        expiresAt: "2026-10-17T14:00:00.000Z",
      })
    })
    expect(source()).toContain("/first/")
    // A frame mounted now takes the newer link.
    const later = render(
      <QueryClientProvider client={cache}>
        <ArtifactFrame version={version} title="Q3 review" />
      </QueryClientProvider>
    )
    expect(later.container.querySelector("iframe")?.getAttribute("src")).toContain("/second/")
  })

  test("drops what it asked a frame that goes before answering", async () => {
    // Reproduce by dropping the cleanup that rejects `pending` in ArtifactFrame: the request
    // waits for good.
    const version = deckVersion()
    const handle = createRef<ArtifactFrameHandle>()
    const ui = render(
      <QueryClientProvider client={frameCache(version)}>
        <ArtifactFrame version={version} title="Q3 review" handle={handle} />
      </QueryClientProvider>
    )
    frameOf(ui.container.querySelector("iframe"))
    const request = handle.current?.send("goto", { slide: 2 })
    ui.unmount()
    const outcome = await Promise.race([
      request?.then(
        () => "answered",
        () => "dropped"
      ),
      Bun.sleep(50).then(() => "waiting"),
    ])
    expect(outcome).toBe("dropped")
  })

  test("sends the theme again when the artifact's own theme arrives", async () => {
    // Reproduce by dropping the effect on `artifactTheme` in ArtifactFrame: a deck whose
    // theme.json is read after its frame is ready never gets its tokens.
    const theme = {
      path: "theme.json",
      file: {
        blobId: "theme",
        digest: `sha256:${"c".repeat(64)}`,
        sizeBytes: 40,
        mediaType: "application/json",
      },
    }
    const version = deckVersion({ files: [theme] })
    const cache = frameCache(version)
    // The theme's file is still on its way, for as long as the test needs.
    const fetch = globalThis.fetch
    globalThis.fetch = (() => new Promise(() => {})) as never
    try {
      const ui = render(
        <QueryClientProvider client={cache}>
          <ArtifactFrame version={version} title="Q3 review" />
        </QueryClientProvider>
      )
      const frame = frameOf(ui.container.querySelector("iframe"))
      await frame.ready()
      const themes = () => frame.requests().filter((request) => request.method === "theme").length
      expect(themes()).toBe(1)
      const source = artifactFileSource({
        artifactId: DECK,
        version: 1,
        path: theme.path,
        fileRef: theme.file,
      })
      await changeCache(() => {
        cache.setQueryData([...source.queryKey, "text"], JSON.stringify({ mode: "dark" }))
      })
      expect(themes()).toBe(2)
    } finally {
      globalThis.fetch = fetch
    }
  })

  test("watches the app's theme once for every frame on the page", async () => {
    // Reproduce by giving each ArtifactFrame its own MutationObserver: three frames, three.
    const version = deckVersion()
    const Observer = browser.MutationObserver
    type Observed = Parameters<InstanceType<typeof Observer>["observe"]>
    let watching = 0
    globalThis.MutationObserver = class extends Observer {
      override observe(target: Observed[0], options: Observed[1]) {
        if ((target as unknown) === document.documentElement) watching += 1
        super.observe(target, options)
      }
    } as never
    try {
      const ui = render(
        <QueryClientProvider client={frameCache(version)}>
          <ArtifactFrame version={version} title="One" />
          <ArtifactFrame version={version} title="Two" start={{ slide: 2 }} />
          <ArtifactFrame version={version} title="Three" start={{ slide: 3 }} />
        </QueryClientProvider>
      )
      for (const element of Array.from(ui.container.querySelectorAll("iframe"))) {
        await frameOf(element).ready()
      }
      expect(watching).toBe(1)
    } finally {
      globalThis.MutationObserver = Observer as never
    }
  })
})

describe("a deck", () => {
  test("trusts its version for its slides and links, not what its frame says", async () => {
    // Reproduce by taking the count from `ready`, the slide from `select` as sent, or opening any
    // address the frame reports: the strip grows to the frame's count, the deck goes past its
    // end, and a script in the deck sends the reader where it likes.
    const opened: ArtifactTarget[] = []
    const version = deckVersion({
      slides: 3,
      references: [{ address: LINKED, as: "link", at: "2", resolvedVersion: 1 }],
    })
    const ui = render(
      <Deck cache={frameCache(version)} version={version} open={(target) => opened.push(target)} />
    )
    const stage = frameOf(ui.container.querySelector("iframe"))
    await stage.ready(50)
    expect(ui.container.querySelectorAll("[data-slide]").length).toBe(3)

    await stage.post({ event: "select", params: { slide: 99 } })
    expect(ui.container.querySelector('[aria-current="true"]')?.getAttribute("data-slide")).toBe(
      "3"
    )

    await stage.post({ event: "open", params: { address: "artifact:art_0000000000" } })
    expect(opened).toEqual([])
    await stage.post({ event: "open", params: { address: LINKED } })
    expect(opened).toEqual([
      { type: "artifact", artifactId: "art_m3tr1csq3a", part: "chart=sla-trend" },
    ])
  })

  test("puts the frame back at the deck's place each time it loads", async () => {
    // Reproduce by sending goto and mode only when a `ready` flag first turns true: a frame that
    // loads again opens at its start while the deck shows another slide.
    const version = deckVersion({ slides: 3 })
    const ui = render(<Deck cache={frameCache(version)} version={version} />)
    const stage = frameOf(ui.container.querySelector("iframe"))
    await stage.ready()
    await act(async () => {
      fireEvent.click(ui.getByRole("button", { name: "Next slide" }))
    })
    expect(stage.requests().at(-1)).toEqual({ method: "goto", params: { slide: 2 } })

    stage.posted.length = 0
    await stage.ready()
    expect(stage.requests()).toContainEqual({ method: "goto", params: { slide: 2 } })
    expect(stage.requests()).toContainEqual({ method: "mode", params: { mode: "slide" } })
  })

  test("says it could not open when its link cannot be had, or it never says it is ready", async () => {
    // Reproduce by ignoring `frame.isError` or the ready timeout in ArtifactFrame: the stage
    // stays an empty slide for good.
    const version = deckVersion()
    const failing = frameCache(version)
    failing
      .getQueryCache()
      .build(failing, { queryKey: ["artifact-frame", DECK, 1] })
      .setState({
        data: undefined,
        status: "error",
        error: new Error("[test] No link."),
        fetchStatus: "idle",
      })
    const failed = render(<Deck cache={failing} version={version} />)
    expect(failed.container.textContent).toContain("These slides could not be opened.")
    failed.unmount()

    jest.useFakeTimers()
    try {
      const ui = render(<Deck cache={frameCache(version)} version={version} />)
      expect(ui.container.textContent).not.toContain("These slides could not be opened.")
      await act(async () => {
        jest.advanceTimersByTime(20_000)
      })
      expect(ui.container.textContent).toContain("These slides could not be opened.")
    } finally {
      jest.useRealTimers()
    }
  })

  test("keeps its filmstrip's frames through the overview", async () => {
    // Reproduce by rendering the Filmstrip only in slide mode: every thumbnail loads again.
    const version = deckVersion({ slides: 2 })
    const ui = render(<Deck cache={frameCache(version)} version={version} />)
    await frameOf(ui.container.querySelector("iframe")).ready()
    const thumbnail = ui.container.querySelector('[data-slide="2"] iframe')
    expect(thumbnail).not.toBeNull()
    await act(async () => {
      fireEvent.click(ui.getByRole("button", { name: "Overview" }))
    })
    expect(ui.container.querySelector('[data-slide="2"]')?.closest("[hidden]")).not.toBeNull()
    await act(async () => {
      fireEvent.click(ui.getByRole("button", { name: "Overview" }))
    })
    // Compared, not matched: a failed match prints the whole page.
    expect(ui.container.querySelector('[data-slide="2"] iframe') === thumbnail).toBe(true)
  })

  test("leaves the rest of the page out of reach while it presents", async () => {
    // Reproduce by dropping `inertAround` from the present effect: a manual popover is not modal,
    // so Tab walks on to the page behind the presentation.
    const outside = document.createElement("button")
    document.body.append(outside)
    const inert = (element: Element | null) => {
      for (let node = element; node; node = node.parentElement) {
        if ((node as HTMLElement).inert) return true
      }
      return false
    }
    try {
      const version = deckVersion({ slides: 2 })
      const ui = render(<Deck cache={frameCache(version)} version={version} />)
      await act(async () => {
        fireEvent.click(ui.getByRole("button", { name: "Present" }))
      })
      const exit = ui.getByRole("button", { name: "Exit presentation" })
      expect(inert(outside)).toBe(true)
      expect(inert(ui.getByRole("button", { name: "Next slide" }))).toBe(true)
      expect(inert(exit)).toBe(false)
      await act(async () => {
        fireEvent.click(exit)
      })
      expect(inert(outside)).toBe(false)
      expect(inert(ui.getByRole("button", { name: "Next slide" }))).toBe(false)
    } finally {
      outside.remove()
    }
  })

  test("in a dialog, takes Escape back to its slide before Escape closes the dialog", async () => {
    // The panel's dialog hears Escape first, on the document as it is captured, and closes unless
    // its handler prevents it; this stands in for it. Radix's portal stays empty here, since
    // Radix is loaded before the page exists. Reproduce by making `leaveEscapeToDeck` do nothing:
    // the dialog would close from the overview.
    const version = deckVersion({ slides: 2 })
    const ui = render(<Deck cache={frameCache(version)} version={version} />)
    const closes: boolean[] = []
    const dialog = (event: KeyboardEvent) => {
      leaveEscapeToDeck(event)
      closes.push(!event.defaultPrevented)
    }
    document.addEventListener("keydown", dialog, { capture: true })
    try {
      const deck = () => ui.container.querySelector<HTMLElement>("[data-deck-mode]")
      const overview = ui.getByRole("button", { name: "Overview" })
      await act(async () => {
        fireEvent.click(overview)
      })
      expect(deck()?.dataset.deckMode).toBe("overview")
      await act(async () => {
        fireEvent.keyDown(overview, { key: "Escape" })
      })
      expect(closes).toEqual([false])
      expect(deck()?.dataset.deckMode).toBe("slide")
      await act(async () => {
        fireEvent.keyDown(overview, { key: "Escape" })
      })
      expect(closes).toEqual([false, true])
    } finally {
      document.removeEventListener("keydown", dialog, { capture: true })
    }
  })
})

describe("a deck's embeds", () => {
  test("are drawn over the frame where it reports them, only those the version records", async () => {
    // Reproduce by drawing every embed the frame reports in DeckEmbeds: the unrecorded address
    // shows too, so a deck could show an artifact it never published with.
    const version = deckVersion({
      references: [{ address: LINKED, as: "embed", at: "1", resolvedVersion: 1 }],
    })
    const ui = render(<Deck cache={frameCache(version)} version={version} />)
    const stage = frameOf(ui.container.querySelector("iframe"))
    await stage.ready()
    const rect = { x: 120, y: 200, width: 600, height: 300 }
    await stage.post({
      event: "embeds",
      params: {
        embeds: [
          { address: LINKED, rect, scale: 0.5 },
          { address: "artifact:art_0000000000#chart=secret", rect, scale: 0.5 },
        ],
      },
    })
    const drawn = Array.from(ui.container.querySelectorAll<HTMLElement>("[data-sixb-deck-embed]"))
    expect(drawn.map((element) => element.dataset.sixbDeckEmbed)).toEqual([LINKED])
    expect(drawn[0]?.style.left).toBe("120px")
    expect(drawn[0]?.style.width).toBe("600px")
    // Laid out at the box over the slide's scale times 1.5, then scaled back up to fit it.
    const inner = drawn[0]?.firstElementChild as HTMLElement | null
    expect(inner?.style.width).toBe("800px")
    expect(inner?.style.transform).toBe("scale(0.75)")
  })
})
