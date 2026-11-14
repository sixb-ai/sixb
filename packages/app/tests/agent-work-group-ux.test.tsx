import { describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { AssistantBody } from "../src/agent/components/message-parts"
import type { NormalizedPart } from "../src/agent/parts"
import { ViewFileToolView } from "../src/agent/view-file/view-file-tool-view"
import { messageFileSource } from "../src/artifacts/file-source"
import { installDom } from "./helpers/dom"

installDom([
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Event",
  "EventTarget",
  "MouseEvent",
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

function mockScrollMetrics(
  element: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number }
) {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => metrics.scrollHeight,
  })
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => metrics.clientHeight,
  })
}

function workUi(queryClient: QueryClient, parts: readonly NormalizedPart[], live: boolean) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AssistantBody parts={parts} live={live} />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

const initialSteps: NormalizedPart[] = [
  {
    kind: "reasoning",
    text: "**Integrating Images**\n\nChecking `git` refs and ![pixel](https://tracker.test/x.png).",
    streaming: false,
  },
  {
    kind: "tool",
    tool: {
      toolName: "bash",
      state: "output-available",
      input: { command: "git status -sb" },
      output: { exitCode: 0, stdout: "## main", stderr: "" },
    },
  },
]

describe("work group UX", () => {
  test("follows live steps, detaches on scroll up with Latest, and resumes on click", async () => {
    // Removal proof: drop `pinToBottom` or `followingRef` in WorkStepsScroll; `scrollTop` stays at
    // 0 on live updates or overwrites the reader's scroll position after scrolling upward.
    const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
    const view = render(workUi(queryClient, initialSteps, true))
    const trigger = view.getByRole("button")

    await act(async () => {
      fireEvent.click(trigger)
    })

    const box = document.querySelector<HTMLElement>("[data-work-scroll]")
    if (!box) throw new Error("Expected work scroll container")
    const metrics = { scrollHeight: 800, clientHeight: 200 }
    mockScrollMetrics(box, metrics)

    // Next streamed step pins to the live bottom (`scrollHeight - clientHeight = 800`).
    const nextSteps: NormalizedPart[] = [
      ...initialSteps,
      { kind: "reasoning", text: "**Verifying CI**\n\nInspecting `biome.json`.", streaming: true },
    ]
    metrics.scrollHeight = 1_000
    view.rerender(workUi(queryClient, nextSteps, true))
    expect(box.scrollTop).toBe(800)
    expect(box.hasAttribute("data-fade-top")).toBe(true)
    expect(box.hasAttribute("data-fade-bottom")).toBe(false)
    expect(document.querySelector("[data-work-latest]")).toBeNull()

    // Reader scrolls up: auto-follow releases, both edges fade, and the Latest pill appears.
    await act(async () => {
      box.scrollTop = 250
      fireEvent.scroll(box)
    })
    expect(box.hasAttribute("data-fade-top")).toBe(true)
    expect(box.hasAttribute("data-fade-bottom")).toBe(true)
    const latestButton = document.querySelector<HTMLElement>("[data-work-latest]")
    expect(latestButton?.textContent).toContain("Latest")

    // Another streamed step does not yank the scroll back down while detached.
    metrics.scrollHeight = 1_240
    const laterSteps: NormalizedPart[] = [
      ...nextSteps,
      { kind: "reasoning", text: "Final check.", streaming: true },
    ]
    view.rerender(workUi(queryClient, laterSteps, true))
    expect(box.scrollTop).toBe(250)

    // Clicking Latest snaps back to the live bottom (`1240 - 200 = 1040`) and dismisses the pill.
    await act(async () => {
      if (latestButton) fireEvent.click(latestButton)
    })
    expect(box.scrollTop).toBe(1_040)
    expect(document.querySelector("[data-work-latest]")).toBeNull()
    queryClient.clear()
  })

  test("opens settled work at the top without a Latest pill", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
    const view = render(workUi(queryClient, initialSteps, false))
    await act(async () => {
      fireEvent.click(view.getByRole("button"))
    })

    const box = document.querySelector<HTMLElement>("[data-work-scroll]")
    expect(box?.scrollTop).toBe(0)
    expect(document.querySelector("[data-work-latest]")).toBeNull()
    queryClient.clear()
  })

  test("formats reasoning Markdown without raw asterisks or remote images", async () => {
    // Removal proof: revert GroupReasoning to a plain `<p>` or omit `REASONING_COMPONENTS`; raw
    // `**Integrating Images**` text or an `<img>` element renders in the trace.
    const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
    const view = render(workUi(queryClient, initialSteps, false))
    await act(async () => {
      fireEvent.click(view.getByRole("button"))
    })

    const prose = document.querySelector(".sixb-reasoning-prose")
    expect(prose?.querySelector("strong")?.textContent).toBe("Integrating Images")
    expect(prose?.querySelector("code")?.textContent).toBe("git")
    expect(prose?.textContent).not.toContain("**Integrating Images**")
    expect(prose?.querySelector("img")).toBeNull()
    queryClient.clear()
  })

  test("opens steps in a bottom sheet on phone viewports", async () => {
    // Removal proof: drop `usePhoneSheet` in WorkGroupView; mobile taps open the nested inline box
    // instead of `[data-work-sheet]`.
    const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
    const previousMatchMedia = Reflect.get(window, "matchMedia")
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query === "(max-width: 767px)",
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    })

    try {
      const view = render(workUi(queryClient, initialSteps, true))
      await act(async () => {
        fireEvent.click(view.getByRole("button"))
      })
      expect(document.querySelector("[data-work-sheet]")).not.toBeNull()
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: previousMatchMedia,
      })
      queryClient.clear()
    }
  })

  test("renders viewed images as compact inline thumbnail rows", () => {
    const fileRef = {
      blobId: "blob_img",
      digest: `sha256:${"b".repeat(64)}`,
      sizeBytes: 4_096,
      fileName: "dock-comparison.png",
      mediaType: "image/png",
    }
    const source = messageFileSource({
      threadId: "thr_1",
      messageId: "msg_1",
      path: "/parts/0/output/content/0/fileRef",
      fileRef,
      baseUrl: "https://example.test",
    })
    const view = render(
      <ViewFileToolView
        tool={{
          toolName: "view_file",
          state: "output-available",
          input: { path: "dock-comparison.png" },
          output: "ok",
          files: [{ fileRef, source }],
        }}
      />
    )

    const img = view.container.querySelector("img")
    expect(img?.className).toContain("size-9")
    expect(view.container.textContent).toContain("Viewed dock-comparison.png")
  })
})
