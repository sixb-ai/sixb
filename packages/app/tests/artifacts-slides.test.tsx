import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { GetArtifactVersionResponse } from "@sixb/client"
import { type DeckMode, FRAME_PROTOCOL, type FrameEvent } from "@sixb/core/artifacts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, render } from "@testing-library/react"
import { Window } from "happy-dom"
import { ArtifactFrame } from "../src/artifacts/frame"
import { deckKeyAction, slideFromPart } from "../src/artifacts/renderers/slides/navigation"
import { SlidesRenderer } from "../src/artifacts/renderers/slides/slides"

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

  test("opens at the slide an address names, within the deck", () => {
    expect(slideFromPart("4", 6)).toBe(4)
    expect(slideFromPart("9", 6)).toBe(6)
    expect(slideFromPart(undefined, 6)).toBe(1)
    expect(slideFromPart("intro", 6)).toBe(1)
  })
})

const browser = new Window({ url: "https://app.sixb.test" })
const globals = [
  "window",
  "self",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLIFrameElement",
  "Event",
  "MessageEvent",
  "EventTarget",
  "MutationObserver",
  "getComputedStyle",
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
afterEach(() => cleanup())
afterAll(() => {
  for (const key of globals) {
    const descriptor = previous.get(key)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  browser.close()
})

describe("a deck's frame", () => {
  test("is sandboxed without the app's origin, and hears only its own frame", async () => {
    // Reproduce by dropping the `event.source` check in ArtifactFrame: another window's message
    // reaches the deck as if its frame had sent it.
    const version: GetArtifactVersionResponse = {
      artifactId: "art_q3dec4000",
      version: 1,
      title: "Q3 review",
      entry: "index.html",
      files: [],
      outline: { kind: "slides", slides: [{ title: "Q3 review" }] },
      references: [],
      author: { type: "user", id: "user-1" },
      createdAt: "2026-10-17T12:00:00.000Z",
    }
    const cache = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
    cache.setQueryData(["artifact-frame", version.artifactId, version.version], {
      path: "/api/artifact-frames/token/",
      expiresAt: "2026-10-17T13:00:00.000Z",
    })
    const events: FrameEvent[] = []
    const ui = render(
      <QueryClientProvider client={cache}>
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
})

describe("a deck's embeds", () => {
  test("are drawn over the frame where it reports them, only those the version records", async () => {
    // Reproduce by drawing every embed the frame reports in DeckEmbeds: the unrecorded address
    // shows too, so a deck could show an artifact it never published with.
    const recorded = "artifact:art_m3tr1csq3a#chart=sla-trend"
    const version: GetArtifactVersionResponse = {
      artifactId: "art_q3dec4000",
      version: 1,
      title: "Q3 review",
      entry: "index.html",
      files: [],
      outline: { kind: "slides", slides: [{ title: "Q3 review" }] },
      references: [{ address: recorded, as: "embed", at: "1", resolvedVersion: 1 }],
      author: { type: "user", id: "user-1" },
      createdAt: "2026-10-17T12:00:00.000Z",
    }
    const cache = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
    cache.setQueryData(["artifact-frame", version.artifactId, version.version], {
      path: "/api/artifact-frames/token/",
      expiresAt: "2026-10-17T13:00:00.000Z",
    })
    const ui = render(
      <QueryClientProvider client={cache}>
        <SlidesRenderer version={version} />
      </QueryClientProvider>
    )
    const frame = ui.container.querySelector("iframe")
    const fromFrame = async (data: Record<string, unknown>) => {
      await act(async () => {
        browser.dispatchEvent(
          new browser.MessageEvent("message", {
            data: { protocol: FRAME_PROTOCOL, ...data },
            source: frame?.contentWindow as never,
          })
        )
      })
    }
    await fromFrame({ event: "ready", params: { slides: 1 } })
    await fromFrame({ id: 1 })
    const rect = { x: 120, y: 200, width: 600, height: 300 }
    await fromFrame({
      event: "embeds",
      params: {
        embeds: [
          { address: recorded, rect, scale: 0.5 },
          { address: "artifact:art_0000000000#chart=secret", rect, scale: 0.5 },
        ],
      },
    })
    const drawn = Array.from(ui.container.querySelectorAll<HTMLElement>("[data-sixb-deck-embed]"))
    expect(drawn.map((element) => element.dataset.sixbDeckEmbed)).toEqual([recorded])
    expect(drawn[0]?.style.left).toBe("120px")
    expect(drawn[0]?.style.width).toBe("600px")
    // Laid out at the box over the slide's scale times 1.5, then scaled back up to fit it.
    const inner = drawn[0]?.firstElementChild as HTMLElement | null
    expect(inner?.style.width).toBe("800px")
    expect(inner?.style.transform).toBe("scale(0.75)")
  })
})
