import { expect, test } from "bun:test"
import type { ListAiModelCallGroupsResponse } from "@sixb/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { AiModelCallsTable } from "../src/components/AiModelCallsTable"

const time = "2026-09-01T12:00:00Z"
const costs = {
  amounts: [{ currency: "USD", amountNanos: "48007392" }],
  reportedCallCount: 9,
  ratedCallCount: 0,
  unpriceableCallCount: 0,
  unvaluedCallCount: 0,
}
const data: ListAiModelCallGroupsResponse = {
  total: 30,
  hasMore: true,
  items: [
    {
      executionId: "parent",
      label: "Workplace forecast",
      canOpenThread: true,
      attribution: { kind: "agent", agentRunId: "run", threadId: "thread" },
      firstCallAt: time,
      lastCallAt: time,
      modelCallCount: 9,
      totalTokens: 81668,
      costs,
      executions: [
        {
          executionId: "parent",
          firstCallAt: time,
          lastCallAt: time,
          modelCallCount: 3,
          costs,
          models: [{ providerId: "gateway", modelId: "openai/gpt-5" }],
        },
        {
          executionId: "child",
          firstCallAt: time,
          lastCallAt: time,
          modelCallCount: 6,
          costs,
          label: "research-task",
          models: [{ providerId: "gateway", modelId: "anthropic/haiku" }],
        },
      ],
    },
  ],
}

function render(overrides: Partial<Parameters<typeof AiModelCallsTable>[0]> = {}) {
  const cache = new QueryClient()
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: cache },
        createElement(
          MemoryRouter,
          null,
          createElement(AiModelCallsTable, {
            data,
            filters: { from: time, to: time },
            loading: false,
            error: false,
            offset: 0,
            filterControl: null,
            onPrevious() {},
            onNext() {},
            onRetry() {},
            ...overrides,
          })
        )
      )
    )
  } finally {
    cache.clear()
  }
}

test("starts collapsed with aggregate totals, source navigation and run pagination", () => {
  // Rendering flat calls, using only direct costs, or opening child rows by default fails this.
  const html = render()
  expect(html).toContain("Workplace forecast")
  expect(html).toContain('aria-expanded="false"')
  expect(html).toContain("1 sub-agent")
  expect(html).toContain("2 models")
  expect(html).toContain("USD 0.048007392")
  expect(html).toContain("81,668")
  expect(html).toContain("1–1 of 30 runs")
  expect(html).toContain('href="/agents/thread"')
  expect(html).not.toContain("research-task")
  expect(html).not.toContain("Loading calls")
})

test("does not link a conversation without read access", () => {
  const html = render({
    data: {
      ...data,
      items: data.items.map((group) => ({ ...group, label: undefined, canOpenThread: false })),
    },
  })
  expect(html).not.toContain('href="/agents/')
  expect(html).not.toContain("Workplace forecast")
})

test("distinguishes unavailable data from an empty result", () => {
  expect(render({ loading: true })).toContain("Loading model calls")
  expect(render({ error: true })).toContain("Could not load model calls.")
  expect(render({ data: { items: [], hasMore: false, total: 0 } })).toContain(
    "No model calls match these filters."
  )
})
