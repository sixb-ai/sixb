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
      costs: {
        amounts: [{ currency: "USD", amountNanos: "625200" }],
        reportedCallCount: 2,
        ratedCallCount: 1,
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
        status: "reported",
        money: { currency: "USD", amountNanos: "530200" },
        reportSource: { providerId: "gateway", responseId: "gen_paid" },
      },
      {
        ...baseCost,
        status: "reported",
        money: { currency: "USD", amountNanos: "0" },
        reportSource: { providerId: "gateway", responseId: "gen_free" },
      },
      {
        ...baseCost,
        status: "rated",
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
    expect(html).toContain("Recorded cost")
    expect(html).toContain("Provider-reported")
    expect(html).toContain("Estimated")
    expect(html).toContain("2 reported · 1 estimated")
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
    expect(html).not.toContain("Catalog-estimated cost")
  } finally {
    cache.clear()
    setSystemTime()
    client.setConfig(previous)
  }
})
