/// <reference path="../src/recharts-lib.d.ts" />
import { expect, setSystemTime, test } from "bun:test"
import {
  client,
  type GetAiAccountingOverviewResponse,
  type ListAiModelCallsResponse,
} from "@sixb/client"
import { getAiAccountingOverviewOptions, listAiModelCallGroupsOptions } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { ModelCallRow } from "../src/components/AiModelCallsTable"
import { AiUsagePage } from "../src/pages/AiUsagePage"

test("shows known token totals with partial coverage and leaves unreported usage unknown", () => {
  // Removal proof: gate Total tokens on usage.reportingStatus === "complete".
  // The partial cases then show an em dash instead of the recorded token sum.
  const previous = client.getConfig()
  client.setConfig({ baseUrl: "http://localhost:3002" })
  setSystemTime(new Date("2026-09-21T00:00:00.000Z"))
  const cache = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  try {
    const range = { from: "2026-09-14T00:00:00.000Z", to: "2026-09-21T00:00:00.000Z" }
    for (const [calls, complete, tokens, formatted] of [
      [87, 84, 4_013_782, "4M"],
      [29, 28, 334_815, "334.8K"],
      [2, 1, 0, "0"],
      [2, 0, 7, "7"],
      [2, 0, undefined, "—"],
    ] as const) {
      const totals: GetAiAccountingOverviewResponse["totals"] = {
        modelCallCount: calls,
        usage: {
          ...(tokens === undefined
            ? {}
            : complete === 0
              ? { inputTokens: 3, outputTokens: 4, totalTokens: tokens }
              : { inputTokens: tokens, outputTokens: 0, totalTokens: tokens }),
          reportingStatus: tokens === undefined ? "unavailable" : "partial",
        },
        usageCoverage: {
          completeCallCount: complete,
          fieldCallCounts: {
            inputTokens: tokens !== undefined && complete === 0 ? 1 : complete,
            outputTokens: tokens !== undefined && complete === 0 ? 1 : complete,
            uncachedInputTokens: 0,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
            textOutputTokens: 0,
            reasoningOutputTokens: 0,
          },
        },
        costs: {
          amounts: [],
          ratedCallCount: 0,
          unpriceableCallCount: 0,
          unvaluedCallCount: calls,
        },
      }
      const overview: GetAiAccountingOverviewResponse = {
        range,
        bucket: "day",
        totals,
        series: [{ ...totals, start: range.from, end: range.to }],
        models: [],
        agents: [],
        workflows: [],
      }
      cache.setQueryData(
        getAiAccountingOverviewOptions({ query: { ...range, bucket: "day" } }).queryKey,
        overview
      )
      const html = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: cache },
          createElement(MemoryRouter, null, createElement(AiUsagePage))
        )
      )
      const card = html.slice(
        html.indexOf("Total tokens"),
        html.indexOf("Model calls", html.indexOf("Total tokens"))
      )
      expect(card).toContain(`>${formatted}</div>`)
      // Reverting "complete usage" to "usage" mislabels the one-sided reports as no usage.
      expect(card).toContain(
        `${tokens === undefined ? "Unavailable" : "Partial"} — complete usage reported for ${complete} of ${calls} calls`
      )
      expect(html).toContain("Known input and output tokens")
    }
  } finally {
    cache.clear()
    setSystemTime()
    client.setConfig(previous)
  }
})

test("shows token ratios only when both meters cover every call", () => {
  // Removal proof: remove the fieldCallCounts guard in usagePercentage. Partial reports then
  // appear as 25%/50%, even when equal reporting counts could describe different calls.
  const previous = client.getConfig()
  client.setConfig({ baseUrl: "http://localhost:3002" })
  setSystemTime(new Date("2026-09-21T00:00:00.000Z"))
  const cache = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  try {
    const range = { from: "2026-09-14T00:00:00.000Z", to: "2026-09-21T00:00:00.000Z" }
    for (const [topLevelCount, detailCount, expectedCache, expectedReasoning] of [
      [2, 2, "25.0%", "50.0%"],
      [2, 1, "—", "—"],
      [1, 2, "—", "—"],
      [1, 1, "—", "—"],
    ] as const) {
      const overview: GetAiAccountingOverviewResponse = {
        range,
        bucket: "day",
        totals: {
          modelCallCount: 2,
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            cacheReadInputTokens: 25,
            reasoningOutputTokens: 10,
            reportingStatus: topLevelCount === 2 ? "complete" : "partial",
          },
          usageCoverage: {
            completeCallCount: topLevelCount,
            fieldCallCounts: {
              inputTokens: topLevelCount,
              outputTokens: topLevelCount,
              cacheReadInputTokens: detailCount,
              reasoningOutputTokens: detailCount,
              uncachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              textOutputTokens: 0,
            },
          },
          costs: { amounts: [], ratedCallCount: 0, unpriceableCallCount: 0, unvaluedCallCount: 2 },
        },
        series: [],
        models: [],
        agents: [],
        workflows: [],
      }
      cache.setQueryData(
        getAiAccountingOverviewOptions({ query: { ...range, bucket: "day" } }).queryKey,
        overview
      )
      const html = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: cache },
          createElement(MemoryRouter, null, createElement(AiUsagePage))
        )
      )
      expect(html.slice(html.indexOf("Cache hit rate"), html.indexOf("Cached input"))).toContain(
        `>${expectedCache}</p>`
      )
      expect(
        html.slice(html.indexOf("Reasoning share"), html.indexOf("Reasoning tokens"))
      ).toContain(`>${expectedReasoning}</p>`)
      expect(html.slice(html.indexOf("Cached input"), html.indexOf("Reasoning share"))).toContain(
        ">25</p>"
      )
      expect(html.slice(html.indexOf("Cached input"), html.indexOf("Reasoning share"))).toContain(
        `usage reported for ${detailCount} of 2 calls`
      )
    }
  } finally {
    cache.clear()
    setSystemTime()
    client.setConfig(previous)
  }
})

test("renders reported and estimated costs with honest coverage and reported zeroes", () => {
  // Restoring catalog-only coverage/labels makes this report 25% instead of 75%.
  const previous = client.getConfig()
  client.setConfig({ baseUrl: "http://localhost:3002" })
  setSystemTime(new Date("2026-09-02T12:00:00.000Z"))
  const cache = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  try {
    const range = { from: "2026-08-26T12:00:00.000Z", to: "2026-09-02T12:00:00.000Z" }
    const aggregate = {
      modelCallCount: 4,
      usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8, reportingStatus: "complete" },
      usageCoverage: {
        completeCallCount: 4,
        fieldCallCounts: {
          inputTokens: 4,
          outputTokens: 4,
          uncachedInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          textOutputTokens: 0,
          reasoningOutputTokens: 0,
        },
      },
      costs: {
        amounts: [{ currency: "USD", amountNanos: "625200" }],
        ratedCallCount: 3,
        unpriceableCallCount: 0,
        unvaluedCallCount: 1,
      },
    } as const
    const overview: GetAiAccountingOverviewResponse = {
      range,
      bucket: "day",
      totals: {
        ...aggregate,
        costs: { ...aggregate.costs, amounts: [...aggregate.costs.amounts] },
      },
      series: [],
      models: [],
      agents: [],
      workflows: [],
    }
    const baseCost = {
      billingIdentity: { providerId: "gateway", modelId: "openai/gpt-5" },
      pricingContext: {},
      ratedAt: range.to,
    }
    const costs: Array<ListAiModelCallsResponse["items"][number]["cost"]> = [
      {
        ...baseCost,
        status: "rated",
        source: "provider",
        components: [],
        money: { currency: "USD", amountNanos: "530200" },
        priceSource: {
          sourceId: "provider-reported",
          sourceEntryId: "gen_paid",
          sourceVersion: "test",
          observedAt: range.to,
        },
      },
      {
        ...baseCost,
        status: "rated",
        source: "provider",
        components: [],
        money: { currency: "USD", amountNanos: "0" },
        priceSource: {
          sourceId: "provider-reported",
          sourceEntryId: "gen_free",
          sourceVersion: "test",
          observedAt: range.to,
        },
      },
      {
        ...baseCost,
        status: "rated",
        source: "estimate",
        money: { currency: "USD", amountNanos: "95000" },
        priceSource: {
          sourceId: "models.dev",
          sourceEntryId: "vercel/openai/gpt-5",
          sourceVersion: "test",
          sourceUrl: "https://models.dev/api.json",
          observedAt: range.to,
        },
        components: [],
      },
      undefined,
    ]
    const calls: ListAiModelCallsResponse = {
      total: 4,
      hasMore: false,
      items: costs.map((cost, index) => ({
        usage: {
          id: `usage_${index}`,
          executionId: "exec_1",
          attempt: 1,
          callId: `call_${index}`,
          providerId: "gateway",
          requestedModelId: "openai/gpt-5",
          providerIds: { responseId: `response_${index}` },
          responseId: `response_${index}`,
          occurredAt: range.to,
          recordedAt: range.to,
          usage: { reportingStatus: "unavailable" },
        },
        ...(cost ? { cost } : {}),
        valuationStatus: cost?.status ?? "unvalued",
      })),
    }
    cache.setQueryData(
      getAiAccountingOverviewOptions({ query: { ...range, bucket: "day" } }).queryKey,
      overview
    )
    cache.setQueryData(
      listAiModelCallGroupsOptions({
        query: {
          ...range,
          providerId: undefined,
          modelId: undefined,
          valuationStatus: undefined,
          limit: "25",
          offset: "0",
        },
      }).queryKey,
      {
        total: 1,
        hasMore: false,
        items: [
          {
            executionId: "exec_1",
            firstCallAt: range.to,
            lastCallAt: range.to,
            modelCallCount: 4,
            costs: aggregate.costs,
            canOpenThread: false,
            executions: [],
          },
        ],
      }
    )
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: cache },
        createElement(MemoryRouter, null, createElement(AiUsagePage))
      )
    )
    expect(html).toContain("Tracked cost")
    expect(html).toContain("3 of 4 calls valued")
    expect(html).toContain("75.0%")
    expect(html).toContain("totals exclude them")
    expect(html).toContain("USD 0.0006252")
    const details = renderToStaticMarkup(
      createElement(
        "table",
        null,
        createElement(
          "tbody",
          null,
          calls.items.map((call) => createElement(ModelCallRow, { key: call.usage.id, call }))
        )
      )
    )
    expect(details).toContain("USD 0.0005302")
    expect(details).toContain("USD 0.00")
    expect(details).toContain("Provider-reported")
    expect(details).toContain("Estimated")
    expect(html).not.toContain("Catalog-estimated cost")
  } finally {
    cache.clear()
    setSystemTime()
    client.setConfig(previous)
  }
})
