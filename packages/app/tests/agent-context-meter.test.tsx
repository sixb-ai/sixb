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

/** Haiku 5.5 on a conversation of 38k: its ×5 tier from 100,001 is the target. */
function context(overrides: Partial<AgentThreadContext> = {}): AgentThreadContext {
  return {
    model: { provider: "vercel-ai-gateway", modelId: "anthropic/claude-haiku-5.5" },
    windowTokens: 1_000_000,
    limitTokens: 983_616,
    target: { tokens: 100_000, limit: "price-tier", tier: { fromTokens: 100_001, priceRatio: 5 } },
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

  // Removal proof: color past a price tier too; Sonnet 4.5 at 23% of its window turns red.
  test("takes a color only by how close it is to its target", () => {
    const quiet = render(<ContextMeter context={context()} modelName="Claude Haiku 5.5" />)
    expect(meter(quiet).getAttribute("aria-label")).toBe("Context: 38k of 100k tokens")
    expect(meter(quiet).dataset.tone).toBe("quiet")
    quiet.unmount()

    expect(contextMeterReading(context({ usedTokens: 85_000 })).tone).toBe("near")
    expect(contextMeterReading(context({ usedTokens: 104_000 })).tone).toBe("over")
    // Past a tier its window target lets it cross: the details say so, the ring stays quiet.
    expect(
      contextMeterReading(
        context({
          usedTokens: 230_000,
          target: {
            tokens: 983_616,
            limit: "window",
            tier: { fromTokens: 200_001, priceRatio: 2 },
          },
        })
      )
    ).toMatchObject({ tone: "quiet", pastTier: true })
  })

  test("opens on what is used, the target and why, the cache and the last condensing", async () => {
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
        modelName="Claude Haiku 5.5"
      />
    )
    fireEvent.click(meter(view))

    const details = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-context-details]")
      if (!found) throw new Error("No details.")
      return found
    })
    const text = details.textContent ?? ""
    expect(text).toContain("38k / 100k")
    expect(text).toContain("38%")
    expect(text).toContain(
      "Claude Haiku 5.5 costs 5× past 100k tokens, so the conversation is condensed before it gets there."
    )
    expect(text).toContain("Read from cache92%")
    expect(text).toContain("Model limit984k")
    expect(text).toContain("Last condensed12m ago · 131k → 41k")
    expect(within(details).getByRole("meter").getAttribute("aria-valuenow")).toBe("38200")
  })

  test("says why a model without a tier worth staying under keeps its window", async () => {
    const view = render(
      <ContextMeter
        context={context({
          usedTokens: 230_000,
          lastCall: undefined,
          target: {
            tokens: 983_616,
            limit: "window",
            tier: { fromTokens: 200_001, priceRatio: 2 },
          },
        })}
        modelName="Claude Sonnet 4.5"
      />
    )
    fireEvent.click(meter(view))

    const details = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-context-details]")
      if (!found) throw new Error("No details.")
      return found
    })
    expect(details.textContent).toContain(
      "Condensed near Claude Sonnet 4.5’s 984k-token limit. Past 200k tokens, each call costs 2×."
    )
    expect(details.textContent).toContain(
      "Past 200k tokens: each call costs 2× until the conversation is condensed."
    )
    expect(details.textContent).not.toContain("Read from cache")
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

  test("turns while the conversation is condensed", () => {
    const view = render(<ContextMeter context={context()} condensing />)
    const button = view.getByRole("button", { name: "Condensing the conversation" })
    expect(button.dataset.condensing).toBe("true")
    expect(button.querySelector("svg")?.getAttribute("class")).toContain("animate-spin")
  })

  // Removal proof: open the details in a plain Popover instead of a ComposerMenu; on a phone they
  // then float off the screen's edge instead of rising as a sheet.
  test("on a phone, a tap opens the details as a bottom sheet beside a fixed-size ring", async () => {
    browser.happyDOM.setViewport({ width: 375, height: 812 })
    try {
      const view = render(<ContextMeter context={context()} modelName="Claude Haiku 5.5" />)
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
        <Composer onSend={() => {}} contextMeter={{ context, modelName: "Claude Haiku 5.5" }} />
      </QueryClientProvider>
    )

  try {
    const shown = renderComposer(context())
    expect(shown.getByRole("button", { name: "Context: 38k of 100k tokens" })).toBeDefined()
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
