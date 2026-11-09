import { describe, expect, test } from "bun:test"
import type { GetArtifactVersionResponse } from "@sixb/client"
import { FRAME_PROTOCOL } from "@sixb/core/artifacts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render } from "@testing-library/react"
import { AppWindow } from "lucide-react"
import { frameLinkKey } from "../src/artifacts/frame"
import { ItemTile, LiveBoard, LiveBoardsProvider } from "../src/artifacts/renderers/canvas/board"
import { installDom } from "./helpers/dom"

const browser = installDom([
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
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

const version = {
  artifactId: "art_l1v3b0ard0",
  version: 1,
  revision: 4,
  frozen: false,
  title: "Onboarding",
  entry: "canvas.json",
  files: [],
  outline: { kind: "canvas", items: [] },
  references: [],
  author: { type: "user", id: "user-1" },
  createdAt: "2026-11-08T09:00:00.000Z",
  updatedAt: "2026-11-08T09:00:00.000Z",
} as unknown as GetArtifactVersionResponse

describe("a board running on the canvas", () => {
  test("draws nothing of its tile once its page is ready", async () => {
    // Reproduce by leaving the tile under the frame in LiveBoard: a page drawn on the board's
    // surface shows the tile's icon through it, in the middle of the board.
    const cache = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
    cache.setQueryData(frameLinkKey(version), {
      path: "/api/artifact-frames/token/",
      expiresAt: "2026-11-08T10:00:00.000Z",
    })
    const ui = render(
      <QueryClientProvider client={cache}>
        <LiveBoardsProvider
          value={{
            version,
            live: { has: () => true, subscribe: () => () => {} },
            previews: {},
            mode: "light",
          }}
        >
          <LiveBoard
            id="home"
            file="boards/home.html"
            title="Home"
            tile={<ItemTile icon={AppWindow} pending />}
          />
        </LiveBoardsProvider>
      </QueryClientProvider>
    )
    const board = () => ui.container.firstElementChild as HTMLElement
    const tile = () => board().querySelector("[aria-busy]")?.parentElement

    // While the page loads, its tile shows.
    expect(board().hasAttribute("data-running")).toBe(false)
    expect(tile()?.className).toContain("group-data-[running]/board:invisible")

    const frame = ui.container.querySelector("iframe")
    if (!frame?.contentWindow) throw new Error("Expected the board's frame.")
    frame.contentWindow.postMessage = (() => {}) as never
    await act(async () => {
      browser.dispatchEvent(
        new browser.MessageEvent("message", {
          data: { protocol: FRAME_PROTOCOL, event: "ready", params: {} },
          source: frame.contentWindow as never,
        })
      )
    })
    expect(board().hasAttribute("data-running")).toBe(true)
    ui.unmount()
  })
})
