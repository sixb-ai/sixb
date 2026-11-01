import { afterAll, describe, expect, setSystemTime, test } from "bun:test"
import { client, type GetAiAccountingOverviewResponse } from "@sixb/client"
import {
  getAiAccountingOverviewOptions,
  getAiLimitStatusOptions,
  getAuthSessionQueryKey,
  listAiModelCallGroupsOptions,
} from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { SectionsProvider } from "../src/pages"
import {
  formatLimitQuantity,
  limitAmountInput,
  limitSubjectChoices,
  limitUsedPercent,
  parseLimitAmount,
} from "../src/pages/settings/usage/format"
import { limitStatusQuery } from "../src/pages/settings/usage/limits"
import { SettingsUsagePage } from "../src/pages/settings/usage/page"
import {
  activeRange,
  colorOf,
  modelColors,
  modelPalette,
  otherModelColor,
  priorRange,
  readFilters,
  spendRange,
  splitMoney,
} from "../src/pages/settings/usage/spend-model"
import { settingsManagerSession } from "./helpers/session"

type Overview = GetAiAccountingOverviewResponse
type Totals = Overview["totals"]

// Generated query keys carry the client's base URL, so it is set before any key is built.
const originalBaseUrl = client.getConfig().baseUrl
client.setConfig({ baseUrl: "http://localhost:3002" })
afterAll(() => client.setConfig({ baseUrl: originalBaseUrl }))

const fieldCounts = (calls: number) => ({
  inputTokens: calls,
  outputTokens: calls,
  uncachedInputTokens: calls,
  cacheReadInputTokens: calls,
  cacheWriteInputTokens: 0,
  textOutputTokens: calls,
  audioDurationMs: 0,
  imageOutputTokens: 0,
  audioOutputTokens: 0,
  outputImages: 0,
  inputCharacters: 0,
  reasoningOutputTokens: 0,
})

/** Calls that cost `dollars`, reading `cached` of their input from cache. */
function aggregate(calls: number, dollars: number, input = 0, cached = 0): Totals {
  return {
    modelCallCount: calls,
    usage: {
      inputTokens: input,
      cacheReadInputTokens: cached,
      outputTokens: calls * 100,
      totalTokens: input + calls * 100,
      reportingStatus: "complete",
    },
    usageCoverage: { completeCallCount: calls, fieldCallCounts: fieldCounts(calls) },
    costs: {
      amounts: [{ currency: "USD", amountNanos: String(Math.round(dollars * 1e9)) }],
      ratedCallCount: calls,
      unpriceableCallCount: 0,
      unvaluedCallCount: 0,
    },
  }
}

function overview(
  range: { from: string; to: string },
  totals: Totals,
  extra: Partial<Overview> = {}
) {
  return {
    range,
    bucket: "day" as const,
    totals,
    series: [],
    modelSeries: [],
    models: [],
    people: [],
    kinds: [],
    agents: [],
    workflows: [],
    ...extra,
  } satisfies Overview
}

const now = "2026-10-30T18:00:00.000Z"
// The week ending with today, in whole UTC days.
const week = { from: "2026-10-24T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" }
const weekBefore = { from: "2026-10-17T00:00:00.000Z", to: "2026-10-24T00:00:00.000Z" }

const overviewKey = (query: Record<string, string>) =>
  getAiAccountingOverviewOptions({ query: { bucket: "day", ...query } as never }).queryKey

function usagePage(address: string, data: readonly (readonly [readonly unknown[], unknown])[]) {
  setSystemTime(new Date(now))
  const cache = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  cache.setQueryData(getAuthSessionQueryKey(), settingsManagerSession)
  for (const [key, value] of data) cache.setQueryData(key, value)
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={cache}>
        <SectionsProvider>
          <MemoryRouter initialEntries={[address]}>
            <SettingsUsagePage />
          </MemoryRouter>
        </SectionsProvider>
      </QueryClientProvider>
    )
  } finally {
    cache.clear()
    setSystemTime()
  }
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replace(/\s+/g, " ")

describe("Usage › Spend", () => {
  test("ranges end with the current period, in whole UTC days or hours", () => {
    expect(spendRange("7d", Date.parse(now))).toMatchObject({ ...week, bucket: "day" })
    expect(spendRange("24h", Date.parse(now))).toMatchObject({
      from: "2026-10-29T19:00:00.000Z",
      to: "2026-10-30T19:00:00.000Z",
      bucket: "hour",
    })
    expect(spendRange("90d", Date.parse(now)).bucket).toBe("week")
    // An unknown range opens the week.
    expect(spendRange("1y", Date.parse(now)).id).toBe("7d")
  })

  test("a picked day narrows the range to it, and compares it with the day before", () => {
    const range = spendRange("7d", Date.parse(now))
    const day = activeRange(range, { day: "2026-10-28T00:00:00.000Z" })
    expect(day).toEqual({ from: "2026-10-28T00:00:00.000Z", to: "2026-10-29T00:00:00.000Z" })
    expect(priorRange(day)).toEqual({
      from: "2026-10-27T00:00:00.000Z",
      to: "2026-10-28T00:00:00.000Z",
    })
    expect(priorRange(activeRange(range, {}))).toEqual(weekBefore)
  })

  test("the address keeps only filters it can read", () => {
    const filters = readFilters(
      new URLSearchParams({
        day: "not a day",
        person: "user:usr_1",
        source: "workflow:service-response",
        kind: "poetry",
        price: "unpriceable",
        provider: "anthropic",
        model: "claude-opus-5.5",
      })
    )
    expect(filters).toEqual({
      person: "user:usr_1",
      source: "workflow:service-response",
      price: "unpriceable",
      provider: "anthropic",
      model: "claude-opus-5.5",
    })
    expect(readFilters(new URLSearchParams({ person: "someone", source: "chats" }))).toEqual({})
  })

  test("the eight costliest models keep their own colors; the rest share a gray", () => {
    const models = Array.from({ length: 9 }, (_, index) => ({
      providerId: "gateway",
      modelId: `model-${index}`,
      // Listed cheapest first, so the colors follow cost rather than order.
      ...aggregate(1, index + 1),
    }))
    const palette = modelPalette(models, "USD")
    expect(palette.get("gateway/model-8")).toBe(modelColors.light[0])
    expect(palette.get("gateway/model-1")).toBe(modelColors.light[7])
    expect(palette.get("gateway/model-0")).toBeUndefined()
    expect(colorOf(palette, "gateway/model-0")).toBe(otherModelColor)
    expect(modelPalette(models, "USD", "dark").get("gateway/model-8")).toBe(modelColors.dark[0])
  })

  test("sets the cents of the hero's amount apart", () => {
    expect(splitMoney(24.82)).toEqual({ whole: "$24", cents: ".82" })
    // French groups with narrow no-break spaces and puts the currency last.
    const french = splitMoney(1234.5, "USD", "fr")
    expect([french.whole, french.cents].map((part) => part.replace(/\s/g, " "))).toEqual([
      "1 234",
      ",50 $US",
    ])
  })

  // Removal proof: have priorRange return the range itself; the hero then compares the week with
  // nothing and the change disappears.
  test("opens on the week's spend, its change and the project's monthly limit", () => {
    const html = text(
      usagePage("/settings/usage", [
        [overviewKey(week), overview(week, aggregate(40, 24.82, 200_000, 150_000))],
        [overviewKey(weekBefore), overview(weekBefore, aggregate(12, 3.36))],
        [
          listAiModelCallGroupsOptions({ query: { ...week, limit: "1" } }).queryKey,
          { items: [], total: 8, hasMore: true },
        ],
        [
          getAiLimitStatusOptions(limitStatusQuery).queryKey,
          {
            items: [
              {
                policy: {
                  id: "ail_1",
                  subject: { type: "project" },
                  limit: {
                    meter: "cost.catalogEstimated",
                    amount: { currency: "USD", amountNanos: "100000000000" },
                  },
                  period: "calendarMonth",
                  enabled: true,
                  createdAt: "2026-10-01T00:00:00.000Z",
                  updatedAt: "2026-10-01T00:00:00.000Z",
                },
                period: {
                  kind: "calendarMonth",
                  start: "2026-10-01T00:00:00.000Z",
                  end: "2026-11-01T00:00:00.000Z",
                  resetAt: "2026-11-01T00:00:00.000Z",
                },
                consumption: {
                  actual: {
                    meter: "cost.catalogEstimated",
                    amount: { currency: "USD", amountNanos: "26400000000" },
                  },
                },
              },
            ],
          },
        ],
      ])
    )
    expect(html).toContain("Oct 24 – 30 · Every model call")
    expect(html).toContain("Click a day, a model or any row below to narrow the whole page.")
    expect(html).toContain("Spent $24 .82")
    expect(html).toContain("↑ $21.46 vs Oct 17 – 23")
    expect(html).toContain("$26.40 of October's $100 limit")
    expect(html).toContain("75% read from cache")
    expect(html).toContain("Conversations and runs 8")
  })

  test("a filter in the address narrows the page and names itself", () => {
    const people = [
      {
        requester: {
          type: "user" as const,
          id: "usr_2",
          name: "Priya Shah",
          email: "priya@example.com",
        },
        ...aggregate(3, 1.2),
      },
    ]
    const narrowed = { ...week, person: "user:usr_2", kind: "language" }
    const html = text(
      usagePage("/settings/usage?person=user%3Ausr_2&kind=language", [
        [overviewKey(week), overview(week, aggregate(40, 24.82), { people })],
        [overviewKey(narrowed), overview(week, aggregate(3, 1.2))],
      ])
    )
    expect(html).toContain("Person Priya Shah")
    expect(html).toContain("Kind Language")
    expect(html).toContain("Clear")
    expect(html).toContain("Spent, filtered $1 .20")
    expect(html).toContain("· 5% of all spend")
    expect(html).not.toContain("narrow the whole page")
  })

  test("limits open on their own tab", () => {
    const html = text(usagePage("/settings/usage?tab=limits", []))
    expect(html).not.toContain("Spent")
    expect(html).toContain("Limits")
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
