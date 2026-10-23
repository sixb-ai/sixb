import { afterAll, describe, expect, setSystemTime, test } from "bun:test"
import {
  client,
  type GetAiAccountingOverviewResponse,
  type ListAiModelCallGroupsResponse,
  type ListAiModelCallsResponse,
} from "@sixb/client"
import {
  getAiAccountingOverviewOptions,
  getAuthSessionQueryKey,
  listAiModelCallGroupsOptions,
} from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { SectionsProvider } from "../src/pages"
import { ModelCallRow, ModelCalls } from "../src/pages/observability/ai-usage/calls"
import {
  formatDuration,
  formatLimitQuantity,
  limitAmountInput,
  limitSubjectChoices,
  limitUsedPercent,
  parseLimitAmount,
} from "../src/pages/observability/ai-usage/format"
import { useKindBreakdown } from "../src/pages/observability/ai-usage/kinds"
import { ObservabilityAiUsagePage } from "../src/pages/observability/ai-usage/page"

type Totals = GetAiAccountingOverviewResponse["totals"]

// Generated query keys carry the client's base URL, so it is set before any key is built.
const originalBaseUrl = client.getConfig().baseUrl
client.setConfig({ baseUrl: "http://localhost:3002" })
afterAll(() => client.setConfig({ baseUrl: originalBaseUrl }))

function markup(ui: ReactNode, data: readonly (readonly [readonly unknown[], unknown])[] = []) {
  const cache = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  cache.setQueryData(getAuthSessionQueryKey(), { authenticated: false, authEnabled: false })
  for (const [key, value] of data) cache.setQueryData(key, value)
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={cache}>
        <SectionsProvider visibility={undefined}>
          <MemoryRouter initialEntries={["/observability/ai-usage"]}>{ui}</MemoryRouter>
        </SectionsProvider>
      </QueryClientProvider>
    )
  } finally {
    cache.clear()
  }
}

/** The AI usage page over one overview, for the week ending at `now`. */
function usagePage(
  now: string,
  overview: Omit<GetAiAccountingOverviewResponse, "range" | "bucket">,
  extra: readonly (readonly [readonly unknown[], unknown])[] = []
) {
  setSystemTime(new Date(now))
  try {
    const to = new Date(now).toISOString()
    const range = { from: new Date(Date.parse(now) - 7 * 86_400_000).toISOString(), to }
    return markup(<ObservabilityAiUsagePage />, [
      [
        getAiAccountingOverviewOptions({ query: { ...range, bucket: "day" } }).queryKey,
        { range, bucket: "day", ...overview },
      ],
      ...extra.map(([key, value]) => [key, value] as const),
    ])
  } finally {
    setSystemTime()
  }
}

const fieldCounts = (counts: Partial<Totals["usageCoverage"]["fieldCallCounts"]>) => ({
  inputTokens: 0,
  outputTokens: 0,
  uncachedInputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  textOutputTokens: 0,
  audioDurationMs: 0,
  imageOutputTokens: 0,
  audioOutputTokens: 0,
  outputImages: 0,
  inputCharacters: 0,
  reasoningOutputTokens: 0,
  ...counts,
})

describe("AI usage", () => {
  // Removal proof: show Total tokens only when usage.reportingStatus is "complete"; the partial
  // cases then read "—" instead of the tokens that were reported.
  test("shows known token totals with partial coverage, and unreported usage as unknown", () => {
    for (const [calls, complete, tokens, formatted] of [
      [87, 84, 4_013_782, "4M"],
      [29, 28, 334_815, "334.8K"],
      [2, 1, 0, "0"],
      [2, 0, 7, "7"],
      [2, 0, undefined, "—"],
    ] as const) {
      const totals: Totals = {
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
          fieldCallCounts: fieldCounts({
            inputTokens: tokens !== undefined && complete === 0 ? 1 : complete,
            outputTokens: tokens !== undefined && complete === 0 ? 1 : complete,
          }),
        },
        costs: {
          amounts: [],
          ratedCallCount: 0,
          unpriceableCallCount: 0,
          unvaluedCallCount: calls,
        },
      }
      const html = usagePage("2026-09-21T00:00:00.000Z", {
        totals,
        series: [{ ...totals, start: "2026-09-14T00:00:00.000Z", end: "2026-09-21T00:00:00.000Z" }],
        models: [],
        kinds: [],
        agents: [],
        workflows: [],
      })
      const start = html.indexOf("Total tokens")
      const card = html.slice(start, html.indexOf("Model calls", start))
      expect(card).toContain(`>${formatted}</div>`)
      // "complete usage", not "usage": the one-sided reports are not missing usage.
      expect(card).toContain(
        `${tokens === undefined ? "Unavailable" : "Partial"} — complete usage reported for ${complete} of ${calls} calls`
      )
      expect(html).toContain("Known input and output tokens")
    }
  })

  // Removal proof: drop the fieldCallCounts checks in usageShare; partial reports then read as
  // 25% and 50%, though equal counts could describe different calls.
  test("shows token ratios only when both meters cover every call", () => {
    for (const [topLevel, detail, cache, reasoning] of [
      [2, 2, "25.0%", "50.0%"],
      [2, 1, "—", "—"],
      [1, 2, "—", "—"],
      [1, 1, "—", "—"],
    ] as const) {
      const html = usagePage("2026-09-21T00:00:00.000Z", {
        totals: {
          modelCallCount: 2,
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            cacheReadInputTokens: 25,
            reasoningOutputTokens: 10,
            reportingStatus: topLevel === 2 ? "complete" : "partial",
          },
          usageCoverage: {
            completeCallCount: topLevel,
            fieldCallCounts: fieldCounts({
              inputTokens: topLevel,
              outputTokens: topLevel,
              cacheReadInputTokens: detail,
              reasoningOutputTokens: detail,
            }),
          },
          costs: { amounts: [], ratedCallCount: 0, unpriceableCallCount: 0, unvaluedCallCount: 2 },
        },
        series: [],
        models: [],
        kinds: [],
        agents: [],
        workflows: [],
      })
      const between = (from: string, to: string) => html.slice(html.indexOf(from), html.indexOf(to))
      expect(between("Cache hit rate", "Cached input")).toContain(`>${cache}</p>`)
      expect(between("Reasoning share", "Reasoning tokens")).toContain(`>${reasoning}</p>`)
      expect(between("Cached input", "Reasoning share")).toContain(">25</p>")
      expect(between("Cached input", "Reasoning share")).toContain(
        `Usage reported for ${detail} of 2 calls`
      )
    }
  })

  // Coverage is the share of calls with a cost, reported or estimated: 3 of 4 here.
  test("counts reported and estimated costs as valued, and shows reported zeroes", () => {
    const now = "2026-09-02T12:00:00.000Z"
    const range = { from: "2026-08-26T12:00:00.000Z", to: now }
    const costs = {
      amounts: [{ currency: "USD", amountNanos: "625200" }],
      ratedCallCount: 3,
      unpriceableCallCount: 0,
      unvaluedCallCount: 1,
    }
    const html = usagePage(
      now,
      {
        totals: {
          modelCallCount: 4,
          usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8, reportingStatus: "complete" },
          usageCoverage: {
            completeCallCount: 4,
            fieldCallCounts: fieldCounts({ inputTokens: 4, outputTokens: 4 }),
          },
          costs,
        },
        series: [],
        models: [],
        kinds: [],
        agents: [],
        workflows: [],
      },
      [
        [
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
                firstCallAt: now,
                lastCallAt: now,
                modelCallCount: 4,
                costs,
                canOpenThread: false,
                executions: [],
              },
            ],
          },
        ],
      ]
    )
    expect(html).toContain("Tracked cost")
    expect(html).toContain("3 of 4 calls valued")
    expect(html).toContain("75.0%")
    expect(html).toContain("1 call has no available cost; totals exclude it")
    expect(html).toContain("USD 0.0006252")

    const base = {
      billingIdentity: { providerId: "gateway", modelId: "openai/gpt-5" },
      pricingContext: {},
      ratedAt: now,
      components: [],
    }
    const source = (id: string) => ({
      sourceId: id,
      sourceEntryId: id,
      sourceVersion: "test",
      observedAt: now,
    })
    const rows = (
      [
        {
          ...base,
          status: "rated",
          source: "provider",
          money: { currency: "USD", amountNanos: "530200" },
          priceSource: source("paid"),
        },
        {
          ...base,
          status: "rated",
          source: "provider",
          money: { currency: "USD", amountNanos: "0" },
          priceSource: source("free"),
        },
        {
          ...base,
          status: "rated",
          source: "estimate",
          money: { currency: "USD", amountNanos: "95000" },
          priceSource: source("models.dev"),
        },
      ] as const
    ).map((cost, index) => call(`usage_${index}`, cost))
    const details = markup(rows.map((entry) => <ModelCallRow key={entry.usage.id} call={entry} />))
    expect(details).toContain("USD 0.0005302")
    // A provider's reported zero is a cost of nothing, not a missing one.
    expect(details).toContain(">USD 0.00<")
    expect(details).toContain("Provider-reported")
    expect(details).toContain("Estimated")
  })
})

describe("usage by kind", () => {
  type Aggregate = Totals
  const aggregate = (
    calls: number,
    complete: number,
    extra: Partial<Aggregate["usage"]> = {}
  ): Aggregate => ({
    modelCallCount: calls,
    usage: {
      ...(complete ? { inputTokens: 900, outputTokens: 100, totalTokens: 1_000 } : {}),
      ...extra,
      reportingStatus: complete === calls ? "complete" : complete ? "partial" : "unavailable",
    },
    usageCoverage: {
      completeCallCount: complete,
      fieldCallCounts: fieldCounts({ inputTokens: complete, outputTokens: complete }),
    },
    costs: {
      amounts: [{ currency: "USD", amountNanos: String(calls * 1_000_000) }],
      ratedCallCount: calls,
      unpriceableCallCount: 0,
      unvaluedCallCount: 0,
    },
  })
  const page = (kinds: GetAiAccountingOverviewResponse["kinds"], totals: Aggregate) =>
    usagePage("2026-09-21T00:00:00.000Z", {
      totals,
      series: [{ ...totals, start: "2026-09-14T00:00:00.000Z", end: "2026-09-21T00:00:00.000Z" }],
      models: [],
      kinds,
      agents: [],
      workflows: [],
    })

  // Removal proof: measure token coverage against every call instead of tokenBilledCalls; the
  // image and speech calls then read as missing tokens and the partial banner returns.
  test("counts no missing tokens for calls billed per image, character or second", () => {
    const html = page(
      [
        { modelKind: "language", ...aggregate(10, 10) },
        { modelKind: "image", ...aggregate(4, 0, { outputImages: 6 }) },
        { modelKind: "speech", ...aggregate(2, 0, { inputCharacters: 18_420 }) },
        { modelKind: "transcription", ...aggregate(1, 0, { audioDurationMs: 1_284_600 }) },
      ],
      aggregate(17, 10, { outputImages: 6, inputCharacters: 18_420, audioDurationMs: 1_284_600 })
    )

    expect(html).toContain("Complete — reported by all 10 token-billed calls")
    expect(html).not.toContain("Accounting coverage is partial")
    expect(html).toContain('aria-label="Break the cost down by"')
    expect(html).not.toContain("Audio duration")
  })

  // Removal proof: sort kinds by cost alone; the costly unclassified calls then lead the list.
  test("break cost down by kind, each in what it produced, unclassified last", () => {
    const overview: GetAiAccountingOverviewResponse = {
      range: { from: "2026-09-14T00:00:00.000Z", to: "2026-09-21T00:00:00.000Z" },
      bucket: "day",
      totals: aggregate(1, 1),
      series: [],
      models: [],
      kinds: [
        { modelKind: "image", ...aggregate(4, 0, { outputImages: 6 }) },
        { ...aggregate(40, 40) },
        { modelKind: "speech", ...aggregate(2, 0, { inputCharacters: 18_420 }) },
        { modelKind: "language", ...aggregate(10, 10) },
        { modelKind: "transcription", ...aggregate(1, 0, { audioDurationMs: 1_284_600 }) },
      ],
      agents: [],
      workflows: [],
    }
    function Rows() {
      return useKindBreakdown(overview, "USD")
        .map((row) => `${row.label} · ${row.detail} · ${row.value}`)
        .join("\n")
    }
    expect(markup(<Rows />).split("\n")).toEqual([
      "Language · 1K tokens · 0.01",
      "Images · 6 images · 0.004",
      "Speech · 18.4K characters · 0.002",
      "Transcription · 21 min 25 s · 0.001",
      "Unclassified · 1K tokens · 0.04",
    ])
  })

  test("still flags token-billed calls that reported nothing", () => {
    const html = page(
      [
        { modelKind: "language", ...aggregate(10, 8) },
        { modelKind: "image", ...aggregate(4, 0, { outputImages: 6 }) },
      ],
      aggregate(14, 8, { outputImages: 6 })
    )
    expect(html).toContain("Partial — reported by 8 of 10 token-billed calls")
    expect(html).toContain("Accounting coverage is partial")
  })

  test("needs no breakdown when every call generated language", () => {
    const html = page([{ modelKind: "language", ...aggregate(10, 10) }], aggregate(10, 10))
    expect(html).not.toContain("Break the cost down by")
    expect(html).toContain("Complete — complete usage reported for 10 of 10 calls")
  })

  test("says durations the way people do", () => {
    const units = {
      seconds: (value: string) => `${value} s`,
      minutes: (minutes: string, seconds: string) => `${minutes} min ${seconds} s`,
      hours: (hours: string, minutes: string) => `${hours} h ${minutes} min`,
    }
    expect(formatDuration(1_250, units)).toBe("1.25 s")
    expect(formatDuration(1_284_600, units)).toBe("21 min 25 s")
    expect(formatDuration(3_840_000, units)).toBe("1 h 4 min")
  })
})

function call(
  id: string,
  cost?: ListAiModelCallsResponse["items"][number]["cost"],
  usage: ListAiModelCallsResponse["items"][number]["usage"]["usage"] = {
    reportingStatus: "unavailable",
  }
): ListAiModelCallsResponse["items"][number] {
  return {
    usage: {
      id,
      executionId: "exec_1",
      attempt: 1,
      callId: id,
      providerId: "gateway",
      requestedModelId: "openai/gpt-5",
      providerIds: {},
      responseId: id,
      occurredAt: "2026-09-01T12:00:00Z",
      recordedAt: "2026-09-01T12:00:00Z",
      usage,
    },
    ...(cost ? { cost } : {}),
    valuationStatus: cost?.status ?? "unvalued",
  }
}

describe("model calls", () => {
  const time = "2026-09-01T12:00:00Z"
  const costs = {
    amounts: [{ currency: "USD", amountNanos: "48007392" }],
    ratedCallCount: 9,
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
  const table = (props: Partial<Parameters<typeof ModelCalls>[0]> = {}) =>
    markup(
      <ModelCalls
        data={data}
        filters={{ from: time, to: time }}
        loading={false}
        error={false}
        offset={0}
        filterControl={null}
        onPrevious={() => {}}
        onNext={() => {}}
        onRetry={() => {}}
        {...props}
      />
    )

  // Listing calls flat, totalling only direct costs, or opening sub-agents by default fails this.
  test("start collapsed, with totals across sub-agents, a link to the source and paging", () => {
    const html = table()
    expect(html).toContain("Workplace forecast")
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain("1 sub-agent")
    expect(html).toContain("2 models")
    expect(html).toContain("USD 0.048007392")
    expect(html).toContain("81,668")
    expect(html).toContain("1–1 of 30 executions")
    expect(html).toContain('href="/agents/thread"')
    expect(html).not.toContain("research-task")
    expect(html).not.toContain("Loading calls")
  })

  test("do not link a conversation the reader may not open", () => {
    const html = table({
      data: {
        ...data,
        items: data.items.map((group) => ({ ...group, label: undefined, canOpenThread: false })),
      },
    })
    expect(html).not.toContain('href="/agents/')
    expect(html).not.toContain("Workplace forecast")
  })

  test("tell loading and failure apart from an empty result", () => {
    expect(table({ loading: true })).toContain("Loading model calls")
    expect(table({ error: true })).toContain("The model calls could not be loaded.")
    expect(table({ data: { items: [], hasMore: false, total: 0 } })).toContain(
      "No model calls match these filters."
    )
  })

  // Removal proof: drop pricedAs from ModelCallRow; neither the matched size nor the price shows.
  test("show an image call's count, matched size and unit price", () => {
    const flux = call(
      "flux",
      {
        status: "rated",
        source: "estimate",
        billingIdentity: { providerId: "gateway", modelId: "bfl/flux-3-image" },
        pricingContext: {},
        priceSource: {
          sourceId: "model-rate-card",
          sourceEntryId: "flux",
          sourceVersion: "1",
          observedAt: time,
        },
        money: { currency: "USD", amountNanos: "96000000" },
        components: [
          {
            meter: "images.output",
            quantity: "2",
            rateAmountNanosPerMillion: "48000000000000",
            chargeAmountNanos: "96000000",
            variant: "1024x1024",
          },
        ],
        ratedAt: time,
      },
      { outputImages: 2, reportingStatus: "partial" }
    )
    const html = markup(
      <ModelCallRow call={{ ...flux, usage: { ...flux.usage, modelKind: "image" } }} />
    )
    expect(html).toContain("Images · 1024x1024")
    expect(html).toContain("2 images")
    expect(html).toContain("2 × USD 0.048")
  })

  test("sum each run's images and audio beside its tokens", () => {
    const html = table({
      data: {
        ...data,
        items: data.items.map((group) => ({
          ...group,
          outputImages: 4,
          audioDurationMs: 184_200,
        })),
      },
    })
    expect(html).toContain("81,668 tokens")
    expect(html).toContain("4 images")
    expect(html).toContain("3 min 4 s of audio")
  })

  // Removal proof: drop the audio duration from ModelCallRow; the duration disappears.
  test("show a transcription's duration without inventing tokens", () => {
    const transcription = call("audio", undefined, {
      audioDurationMs: 1250,
      reportingStatus: "partial",
    })
    const html = markup(
      <ModelCallRow
        call={{ ...transcription, usage: { ...transcription.usage, modelKind: "transcription" } }}
      />
    )
    expect(html).toContain("Transcription")
    expect(html).toContain("1.25 s of audio")
    expect(html).not.toContain("0 tokens")
  })
})

describe("AI limit amounts", () => {
  test("take whole token counts only", () => {
    expect(parseLimitAmount("tokens.total", "12500")).toEqual({
      ok: true,
      quantity: { meter: "tokens.total", amount: 12_500 },
    })
    expect(parseLimitAmount("tokens.total", "1.5")).toEqual({ ok: false, error: "wholeTokens" })
    expect(parseLimitAmount("tokens.total", "9007199254740992")).toEqual({
      ok: false,
      error: "tooManyTokens",
    })
  })

  test("read a decimal cost as exact nanounits", () => {
    const parsed = parseLimitAmount("cost.catalogEstimated", "1234.000000009", "usd")
    expect(parsed).toEqual({
      ok: true,
      quantity: {
        meter: "cost.catalogEstimated",
        amount: { currency: "USD", amountNanos: "1234000000009" },
      },
    })
    if (!parsed.ok) throw new Error("expected a parsed cost limit")
    expect(limitAmountInput(parsed.quantity)).toBe("1234.000000009")
    expect(formatLimitQuantity(parsed.quantity, (count) => `${count} tokens`)).toBe("USD 1,234.00")
    expect(parseLimitAmount("cost.catalogEstimated", "1", "EUR")).toEqual({
      ok: false,
      error: "currency",
    })
    expect(parseLimitAmount("cost.catalogEstimated", "1.0000000001").ok).toBe(false)
    expect(parseLimitAmount("cost.catalogEstimated", "9223372036.854775808")).toEqual({
      ok: false,
      error: "costTooLarge",
    })
  })

  // Regression check: dropping separators instead of refusing them turns 1,50 into 150.
  test("refuse decimal and grouping separators rather than guess them", () => {
    for (const amount of ["1,50", "1,234", "1,234.56", "1.234,56", "1 234", "1 234"]) {
      for (const meter of ["tokens.total", "cost.catalogEstimated"] as const) {
        expect(parseLimitAmount(meter, amount)).toEqual({ ok: false, error: "separators" })
      }
    }
    expect(parseLimitAmount("cost.catalogEstimated", " 1.50 ")).toMatchObject({
      ok: true,
      quantity: { amount: { amountNanos: "1500000000" } },
    })
  })

  test("count what is used, reserved and of unknown outcome against the limit", () => {
    const tokens = (amount: number) => ({ meter: "tokens.total" as const, amount })
    expect(
      limitUsedPercent({
        limit: tokens(1_000),
        actual: tokens(400),
        reserved: tokens(100),
        unknown: tokens(50),
      })
    ).toBe(55)
    const usd = (amountNanos: string) => ({
      meter: "cost.catalogEstimated" as const,
      amount: { currency: "USD" as const, amountNanos },
    })
    expect(
      limitUsedPercent({
        limit: usd("100000000000"),
        actual: usd("82096"),
        reserved: usd("0"),
        unknown: usd("0"),
      })
    ).toBe(0.000082)
  })

  test("name the groups, people and service accounts a limit can apply to", () => {
    const statuses = { active: "Active", suspended: "Suspended" }
    const directory = {
      groups: [{ id: "customer-success", label: "Customer success" }],
      users: [
        {
          id: "usr_1",
          email: "ada@example.com",
          displayName: "Ada Lovelace",
          status: "active" as const,
        },
      ],
      serviceAccounts: [{ id: "svc_1", name: "Billing automation", status: "suspended" as const }],
    }
    expect(limitSubjectChoices(directory, "group", statuses)).toEqual([
      { value: "customer-success", label: "Customer success" },
    ])
    expect(limitSubjectChoices(directory, "user", statuses)).toEqual([
      { value: "usr_1", label: "Ada Lovelace", description: "ada@example.com · Active" },
    ])
    expect(limitSubjectChoices(directory, "serviceAccount", statuses)).toEqual([
      { value: "svc_1", label: "Billing automation", description: "Suspended" },
    ])
  })
})
