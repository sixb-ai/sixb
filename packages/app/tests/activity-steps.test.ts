import { describe, expect, test } from "bun:test"
import type { GetActivityVisitTimelineResponse } from "@sixb/client"
import { filterSteps, type VisitStep, visitSteps } from "../src/pages/observability/activity/steps"

type Timeline = GetActivityVisitTimelineResponse
type Entry = Timeline["entries"][number]

const start = Date.parse("2026-10-02T09:00:00.000Z")
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString()

let sequence = 0
const page = (seconds: number, route: string): Entry => ({
  kind: "page",
  at: at(seconds),
  sequence: ++sequence,
  route,
})
const click = (seconds: number, name: string, route: string): Entry => ({
  kind: "interaction",
  at: at(seconds),
  sequence: ++sequence,
  name,
  route,
})
const action = (seconds: number, actionId: string): Entry => ({
  kind: "action",
  at: at(seconds),
  executionId: `exe_${seconds}`,
  actionId,
  runId: `act_${seconds}`,
  status: "succeeded",
  runVisible: true,
})

function timeline(
  entries: readonly Entry[],
  options: { readonly lastSeenAt?: number; readonly truncated?: boolean } = {}
): Pick<Timeline, "entries" | "visit" | "truncated"> {
  return {
    entries: [...entries],
    truncated: options.truncated ?? false,
    visit: {
      id: "visit_1",
      actor: { type: "user", userId: "usr_1" },
      attribution: {},
      startedAt: at(0),
      lastSeenAt: at(options.lastSeenAt ?? 600),
      pageViews: entries.filter((entry) => entry.kind === "page").length,
      interactions: entries.filter((entry) => entry.kind === "interaction").length,
    },
  }
}

/** Each step as its route, its time span in seconds, its view of the route and its entries. */
function shape(steps: readonly VisitStep[]) {
  const seconds = (value: string | null) =>
    value === null ? null : (Date.parse(value) - start) / 1000
  return steps.map((step) => ({
    route: step.page?.route ?? null,
    from: seconds(step.at),
    until: seconds(step.until),
    last: step.last,
    view: step.view,
    entries: step.entries.map((entry) => entry.kind),
  }))
}

describe("a visit's steps", () => {
  test("an empty visit has none", () => {
    expect(visitSteps(timeline([]))).toEqual([])
  })

  // Regression proof: end each step at its own last entry instead of the next page view, and the
  // first step lasts 30 s, not 120.
  test("each page view is a step, until the next one; the last lasts until the last activity", () => {
    const steps = visitSteps(
      timeline(
        [
          page(0, "/invoices"),
          click(10, "invoices.row.open", "/invoices"),
          action(30, "markPaid"),
          page(120, "/invoices/:invoiceId"),
          page(160, "/agents"),
        ],
        { lastSeenAt: 400 }
      )
    )

    expect(shape(steps)).toEqual([
      {
        route: "/invoices",
        from: 0,
        until: 120,
        last: false,
        view: 1,
        entries: ["interaction", "action"],
      },
      { route: "/invoices/:invoiceId", from: 120, until: 160, last: false, view: 1, entries: [] },
      { route: "/agents", from: 160, until: 400, last: true, view: 1, entries: [] },
    ])
  })

  // Regression proof: count views per visit instead of per route, and /invoices/:invoiceId reads
  // as a 2nd time.
  test("a route viewed again counts its views, the same route twice in a row included", () => {
    const steps = visitSteps(
      timeline([
        page(0, "/"),
        page(10, "/invoices/:invoiceId"),
        page(20, "/"),
        page(30, "/"),
        page(40, "/invoices/:invoiceId"),
      ])
    )

    expect(steps.map((step) => [step.page?.route, step.view])).toEqual([
      ["/", 1],
      ["/invoices/:invoiceId", 1],
      ["/", 2],
      ["/", 3],
      ["/invoices/:invoiceId", 2],
    ])
  })

  // Regression proof: drop entries that come before any step, and the click and the action are
  // lost.
  test("what came before the first page view leads as a step of its own, with no end", () => {
    const steps = visitSteps(
      timeline([click(0, "notes.export", "/notes"), action(5, "archive"), page(20, "/invoices")], {
        lastSeenAt: 20,
      })
    )

    expect(steps[0]?.key).toBe("earlier")
    expect(shape(steps)).toEqual([
      {
        route: null,
        from: 0,
        until: null,
        last: false,
        view: 0,
        entries: ["interaction", "action"],
      },
      { route: "/invoices", from: 20, until: 20, last: true, view: 1, entries: [] },
    ])
  })

  // Regression proof: ignore `truncated`, and the cut step claims to end at the visit's last
  // activity, which may be hours after what the timeline kept.
  test("a cut timeline's last step is not the visit's: its end is unknown", () => {
    const steps = visitSteps(
      timeline([page(0, "/"), page(60, "/reports")], { lastSeenAt: 7200, truncated: true })
    )

    expect(shape(steps).at(-1)).toEqual({
      route: "/reports",
      from: 60,
      until: null,
      last: false,
      view: 1,
      entries: [],
    })
  })

  test("the last step never ends before it starts", () => {
    const [step] = visitSteps(timeline([page(30, "/")], { lastSeenAt: 20 }))
    expect(step?.until).toBe(step?.at)
  })
})

describe("filtering a visit's steps", () => {
  const steps = visitSteps(
    timeline([
      click(0, "notes.export", "/notes"),
      page(10, "/"),
      click(20, "notes.export", "/"),
      action(30, "acknowledgeNote"),
      page(40, "/objects/:objectTypeId/:primaryId"),
      page(50, "/"),
      action(60, "archive"),
    ])
  )
  const kept = (kind: Parameters<typeof filterSteps>[1]) =>
    filterSteps(steps, kind).map((step) => [
      step.page?.route ?? null,
      step.entries.map((e) => e.kind),
    ])

  test("all keeps every step and entry", () => {
    expect(kept("all")).toEqual([
      [null, ["interaction"]],
      ["/", ["interaction", "action"]],
      ["/objects/:objectTypeId/:primaryId", []],
      ["/", ["action"]],
    ])
  })

  // Regression proof: keep every step under a kind, and the empty object page step stays.
  test("a kind keeps the steps holding it, each with that kind only", () => {
    expect(kept("action")).toEqual([
      ["/", ["action"]],
      ["/", ["action"]],
    ])
    expect(kept("interaction")).toEqual([
      [null, ["interaction"]],
      ["/", ["interaction"]],
    ])
    expect(kept("workflow")).toEqual([])
  })

  test("pages keeps the page views alone", () => {
    expect(kept("page")).toEqual([
      ["/", []],
      ["/objects/:objectTypeId/:primaryId", []],
      ["/", []],
    ])
  })
})
