import { afterAll, describe, expect, mock, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, waitFor, within } from "@testing-library/react"
import { useLayoutEffect } from "react"
import { Composer } from "../src/agent/components/composer"
import { ContextMeter, contextMeterReading } from "../src/agent/components/context-meter"
import { formatTokenCount } from "../src/agent/format"
import type { AgentThreadContext } from "../src/agent/types"
import { installDom } from "./helpers/dom"

const browser = installDom([
  "document",
  "navigator",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Event",
  "CustomEvent",
  "EventTarget",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "PointerEvent",
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

// Radix picks its layout effect when it loads, a no-op without a `document`, and its popovers then
// never mount. This file or another of the run loads it before the window exists, so it is given
// React's own, and its own back after the file.
const radix = Bun.resolveSync("radix-ui", Bun.resolveSync("@sixb/ui/components", import.meta.dir))
const layoutEffect = Bun.resolveSync(
  "@radix-ui/react-use-layout-effect",
  Bun.resolveSync("@radix-ui/react-portal", Bun.resolveSync("@radix-ui/react-dialog", radix))
)
const loaded: typeof import("react").useLayoutEffect = (await import(layoutEffect)).useLayoutEffect
mock.module(layoutEffect, () => ({ useLayoutEffect }))
afterAll(() => {
  mock.module(layoutEffect, () => ({ useLayoutEffect: loaded }))
})

/** A conversation of 38k on a model with a 200k window: 183,616 tokens of input at most. */
function context(overrides: Partial<AgentThreadContext> = {}): AgentThreadContext {
  return {
    model: { provider: "vercel-ai-gateway", modelId: "anthropic/claude-haiku-4.5" },
    windowTokens: 200_000,
    limitTokens: 183_616,
    usedTokens: 38_200,
    lastCall: {
      inputTokens: 37_000,
      outputTokens: 1_200,
      cacheReadInputTokens: 34_040,
      occurredAt: new Date(Date.now() - 60_000).toISOString(),
    },
    ...overrides,
  }
}

function meter(view: ReturnType<typeof render>) {
  return view.getByRole("button", { name: /^Context/ })
}

describe("the context meter", () => {
  test("shows nothing before the conversation's first answer", () => {
    const view = render(<ContextMeter context={context({ usedTokens: undefined })} />)
    expect(view.container.innerHTML).toBe("")
    expect(render(<ContextMeter />).container.innerHTML).toBe("")
  })

  test("takes a color only by how close it is to its model's limit", () => {
    const quiet = render(<ContextMeter context={context()} modelName="Claude Haiku 4.5" />)
    expect(meter(quiet).getAttribute("aria-label")).toBe("Context: 38k of 184k tokens")
    expect(meter(quiet).dataset.tone).toBe("quiet")
    quiet.unmount()

    expect(contextMeterReading(context({ usedTokens: 150_000 })).tone).toBe("near")
    expect(contextMeterReading(context({ usedTokens: 190_000 })).tone).toBe("over")
  })

  test("opens on what is used of the limit, the cache and the last condensing", async () => {
    const view = render(
      <ContextMeter
        context={context({
          lastCompaction: {
            reason: "threshold",
            createdAt: new Date(Date.now() - 12 * 60_000).toISOString(),
            estimatedInputTokensBefore: 131_000,
            estimatedInputTokensAfter: 41_000,
          },
        })}
        modelName="Claude Haiku 4.5"
      />
    )
    fireEvent.click(meter(view))

    const details = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-context-details]")
      if (!found) throw new Error("No details.")
      return found
    })
    const text = details.textContent ?? ""
    expect(text).toContain("38k / 184k")
    expect(text).toContain("21%")
    expect(text).toContain("Claude Haiku 4.5")
    expect(text).toContain("Earlier messages are condensed as it nears 184k\u00a0tokens.")
    expect(text).toContain("Read from cache92%")
    expect(text).toContain("Last condensed12m ago · 131k → 41k")
    expect(within(details).getByRole("meter").getAttribute("aria-valuenow")).toBe("38200")
  })

  // Removal proof: put every relative time through `ago`; a week-old one reads "Oct 24 ago".
  test("names a condensing over a week old by its date", async () => {
    const createdAt = new Date(Date.now() - 9 * 24 * 60 * 60_000)
    const view = render(
      <ContextMeter
        context={context({
          lastCompaction: {
            reason: "threshold",
            createdAt: createdAt.toISOString(),
            estimatedInputTokensBefore: 131_000,
            estimatedInputTokensAfter: 41_000,
          },
        })}
      />
    )
    fireEvent.click(meter(view))

    const details = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-context-details]")
      if (!found) throw new Error("No details.")
      return found
    })
    const date = createdAt.toLocaleDateString("en", { month: "short", day: "numeric" })
    expect(details.textContent).toContain(`Last condensed${date} · 131k → 41k`)
    expect(details.textContent).not.toContain("ago")
  })

  // Removal proof: draw the arc from the share alone (no RING_MIN_SHARE); a conversation at 0.5%
  // of its limit draws a dot on the track that reads as nothing, or as a spinner's head.
  test("reads as a gauge at any level: a full track and an arc, which breathes while condensed", () => {
    const low = render(<ContextMeter context={context({ usedTokens: 900 })} />)
    const [track, arc] = Array.from(meter(low).querySelectorAll("circle"))
    expect(track?.getAttribute("stroke-dasharray")).toBeNull()
    const length = Number(arc?.getAttribute("stroke-dasharray"))
    const offset = Number(arc?.getAttribute("stroke-dashoffset"))
    // At least a fifteenth of the ring, from twelve o'clock.
    expect((length - offset) / length).toBeGreaterThan(1 / 15)
    low.unmount()

    const view = render(<ContextMeter context={context()} condensing />)
    const button = view.getByRole("button", { name: "Condensing the conversation" })
    expect(button.dataset.condensing).toBe("true")
    expect(button.innerHTML).not.toContain("animate-spin")
    expect(button.innerHTML).toContain("animate-pulse")
  })

  // Removal proof: leave the answer's room out of contextMeterReading; the bar and its legend no
  // longer add up to the model's window.
  test("lists what each part uses, the room left and the room kept for the answer", async () => {
    const parts = [
      { part: "system" as const, tokens: 9_000 },
      { part: "tools" as const, tokens: 6_200 },
      { part: "messages" as const, tokens: 8_000 },
      { part: "toolResults" as const, tokens: 15_000 },
    ]
    const reading = contextMeterReading(context({ parts }))
    expect(reading.used + reading.freeTokens + reading.reservedTokens).toBe(200_000)

    const view = render(<ContextMeter context={context({ parts })} modelName="Claude Haiku 4.5" />)
    fireEvent.click(meter(view))
    const details = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-context-details]")
      if (!found) throw new Error("No details.")
      return found
    })
    const rows = within(details)
      .getAllByRole("listitem")
      .map((row) => row.textContent)
    expect(rows).toEqual([
      "Sixb instructions9k24%",
      "Tools6.2k16%",
      "Messages8k21%",
      "Tool results15k39%",
      "Free space145k",
      "Kept for the answer16k",
    ])
  })

  test("says what happens when the conversation nears its limit, and past it", async () => {
    for (const [usedTokens, said] of [
      [150_000, "Almost full: earlier messages will be condensed soon."],
      [190_000, "Full: earlier messages are condensed before the next answer."],
    ] as const) {
      const view = render(<ContextMeter context={context({ usedTokens })} />)
      fireEvent.click(meter(view))
      const details = await waitFor(() => {
        const found = document.querySelector<HTMLElement>("[data-context-details]")
        if (!found) throw new Error("No details.")
        return found
      })
      expect(details.textContent).toContain(said)
      view.unmount()
    }
  })

  // Removal proof: open the details in a plain Popover instead of a ComposerMenu; on a phone they
  // then float off the screen's edge instead of rising as a sheet.
  test("on a phone, a tap opens the details as a bottom sheet beside a fixed-size ring", async () => {
    browser.happyDOM.setViewport({ width: 375, height: 812 })
    try {
      const view = render(<ContextMeter context={context()} modelName="Claude Haiku 4.5" />)
      const button = meter(view)
      // A fixed 36px target that never shrinks the composer's text below it.
      expect(button.className).toContain("size-9")
      expect(button.className).toContain("shrink-0")

      fireEvent.click(button)
      const sheet = await waitFor(() => {
        const found = document.querySelector<HTMLElement>("[data-slot=drawer-content]")
        if (!found) throw new Error("No bottom sheet.")
        return found
      })
      expect(sheet.querySelector("[data-context-details]")).not.toBeNull()
      expect(document.querySelector("[data-slot=popover-content]")).toBeNull()
    } finally {
      browser.happyDOM.setViewport({ width: 1024, height: 768 })
    }
  })
})

test("the composer shows the meter beside the model, and leaves it out without a context", () => {
  const queryClient = new QueryClient()
  const renderComposer = (context?: AgentThreadContext) =>
    render(
      <QueryClientProvider client={queryClient}>
        <Composer onSend={() => {}} contextMeter={{ context, modelName: "Claude Haiku 4.5" }} />
      </QueryClientProvider>
    )

  try {
    const shown = renderComposer(context())
    expect(shown.getByRole("button", { name: "Context: 38k of 184k tokens" })).toBeDefined()
    shown.unmount()

    const fresh = renderComposer()
    expect(fresh.queryByRole("button", { name: /^Context/ })).toBeNull()
  } finally {
    queryClient.clear()
  }
})

test("token counts read as a meter shows them", () => {
  expect(
    [950, 9_540, 38_200, 100_001, 983_616, 1_000_000, 1_250_000].map((tokens) =>
      formatTokenCount(tokens)
    )
  ).toEqual(["950", "9.5k", "38k", "100k", "984k", "1M", "1.3M"])
  expect(formatTokenCount(9_540, "fr")).toBe("9,5k")
})
