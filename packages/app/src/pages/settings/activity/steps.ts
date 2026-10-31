import type { GetActivityVisitTimelineResponse } from "@sixb/client"

type Timeline = GetActivityVisitTimelineResponse
type Entry = Timeline["entries"][number]
type PageEntry = Extract<Entry, { readonly kind: "page" }>

/** One page view of a visit, with what happened while it was the last page viewed. */
export interface VisitStep {
  /** `page:<sequence>`, or `earlier`. */
  readonly key: string
  /** Null for what came before the visit's first page view. */
  readonly page: PageEntry | null
  /** When the step began: its page view, or the first entry before any. */
  readonly at: string
  /**
   * When it ended: the next page view, or the visit's last activity for its last step. Null
   * before the first page view, and for the last step of a timeline cut short, whose end is not
   * in it.
   */
  readonly until: string | null
  /** The visit's last page view, its end being the visit's last activity. */
  readonly last: boolean
  /** How many times the step's route has been viewed so far in the visit, this view included. */
  readonly view: number
  /** Its interactions, actions, workflows and Agent runs, by time. */
  readonly entries: readonly Entry[]
}

/**
 * A visit as steps: one per page view, in order, each holding the entries that came after it and
 * before the next, as the timeline reads them. What came before the first page view, such as a
 * click recorded just as someone came back, leads as a step of its own.
 *
 * The timeline places a page view at the server's receipt and an execution at its creation, two
 * clocks a navigation can fall between: an action started as the page changed can land in the
 * step next to the one it was started from.
 */
export function visitSteps(
  timeline: Pick<Timeline, "entries" | "visit" | "truncated">
): VisitStep[] {
  type Draft = Omit<VisitStep, "until" | "last" | "entries"> & { entries: Entry[] }

  const drafts: Draft[] = []
  const views = new Map<string, number>()

  for (const entry of timeline.entries) {
    if (entry.kind === "page") {
      const view = (views.get(entry.route) ?? 0) + 1
      views.set(entry.route, view)
      drafts.push({ key: `page:${entry.sequence}`, page: entry, at: entry.at, view, entries: [] })
      continue
    }

    const current = drafts.at(-1)
    if (current) {
      current.entries.push(entry)
    } else {
      drafts.push({ key: "earlier", page: null, at: entry.at, view: 0, entries: [entry] })
    }
  }

  return drafts.map((draft, index) => {
    const next = drafts[index + 1]
    // A cut timeline's last step is not the visit's: its end is in what the cut left out.
    const last = next === undefined && draft.page !== null && !timeline.truncated

    const until =
      draft.page === null
        ? null
        : next
          ? next.at
          : last
            ? latest(draft.at, timeline.visit.lastSeenAt)
            : null

    return { ...draft, until, last }
  })
}

/** The later of two instants: a visit's last activity is never before its last page view. */
function latest(a: string, b: string): string {
  return Date.parse(b) > Date.parse(a) ? b : a
}

/**
 * The steps a filter keeps: all of them; with Pages, the page views alone; with another kind,
 * the steps holding that kind, each with those entries only.
 */
export function filterSteps(steps: readonly VisitStep[], kind: "all" | Entry["kind"]): VisitStep[] {
  if (kind === "all") {
    return [...steps]
  }

  if (kind === "page") {
    return steps.flatMap((step) => (step.page ? [{ ...step, entries: [] }] : []))
  }

  return steps.flatMap((step) => {
    const entries = step.entries.filter((entry) => entry.kind === kind)
    return entries.length > 0 ? [{ ...step, entries }] : []
  })
}
