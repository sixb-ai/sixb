import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import {
  client,
  type GetActionRunResponse,
  type GetActivityVisitTimelineResponse,
} from "@sixb/client"
import { getAuthSessionQueryKey } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, renderHook, waitFor, within } from "@testing-library/react"
import { MemoryRouter, useLocation } from "react-router-dom"
import { SectionsProvider } from "../src/pages"
import {
  effectsOutcomeWaitMs,
  effectsState,
  effectsWaitRemainingMs,
} from "../src/pages/observability/action-run"
import { ObservabilityActivityPage } from "../src/pages/observability/activity/page"
import { VisitEntries } from "../src/pages/observability/activity/timeline"
import { useActivityUsers } from "../src/pages/observability/activity/users"
import { ObservabilityAiUsagePage } from "../src/pages/observability/ai-usage/page"
import { ObservabilityLogsPage } from "../src/pages/observability/logs"
import { ObservabilityRunsPage } from "../src/pages/observability/runs"
import { installDom } from "./helpers/dom"
import { stubWebSockets } from "./helpers/offline-sockets"

installDom([
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLFormElement",
  "HTMLSelectElement",
  "Event",
  "EventTarget",
  "MouseEvent",
  "KeyboardEvent",
  "MutationObserver",
  "getComputedStyle",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  // The Activity page's user filter is a popover, which measures its anchor.
  "ResizeObserver",
  "DOMRect",
])
const originalConfig = client.getConfig()
// Generated query keys carry the client's base URL, so it is set before any key is built.
client.setConfig({ baseUrl: "https://api.sixb.test" })
let sockets: ReturnType<typeof stubWebSockets> | undefined

beforeAll(() => {
  sockets = stubWebSockets()
})

afterEach(() => {
  client.setConfig({ fetch: originalConfig.fetch })
})

afterAll(() => {
  client.setConfig({ baseUrl: originalConfig.baseUrl })
  sockets?.restore()
})

describe("an action run's effects", () => {
  const finishedAt = "2026-06-29T12:00:00.000Z"
  const finished = Date.parse(finishedAt)
  const run = (overrides: Partial<GetActionRunResponse> = {}): GetActionRunResponse => ({
    id: "act_1",
    projectId: "proj",
    actionId: "notify",
    subject: { kind: "none" },
    status: "succeeded",
    phase: "commit",
    startedAt: "2026-06-29T11:59:59.000Z",
    finishedAt,
    params: {},
    ...overrides,
  })

  // Removal proof: drop the time bound from effectsState; a run whose outcome never lands stays
  // pending, and its page polls forever. The page draws again after the remaining wait, since its
  // last poll changes nothing: return a shorter wait and the page shows "pending" once more, then
  // never again.
  test("are waited for only a while after the run ended, and stop exactly when no outcome is expected", () => {
    const now = finished + 1_000
    const remaining = effectsWaitRemainingMs(run(), now)
    expect(now + remaining).toBe(finished + effectsOutcomeWaitMs)
    expect(effectsState(run(), true, now)).toBe("pending")
    expect(effectsState(run(), true, now + remaining - 1)).toBe("pending")
    expect(effectsState(run(), true, now + remaining)).toBe("unrecorded")
    expect(effectsWaitRemainingMs(run(), finished + effectsOutcomeWaitMs + 5_000)).toBe(0)
  })

  test("read as settled once recorded, or when the action has none", () => {
    const effects = { status: "succeeded" as const, completedAt: finishedAt }
    expect(effectsState(run({ phase: "effects", effects }), true, finished)).toBe("recorded")
    expect(effectsState(run(), false, finished)).toBe("none")
    expect(effectsState(run({ phase: "writeback" }), true, finished)).toBe("none")
    expect(effectsState(run({ status: "failed" }), true, finished)).toBe("none")
  })
})

function Location() {
  const location = useLocation()
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>
}

describe("Runs", () => {
  // Removal proof: set each filter with its own setSearchParams call; each call starts from the
  // same URL, so the last one wins and the workflow filter rides along into Actions.
  test("switching to action runs clears the workflow filters", async () => {
    const empty = { runs: [], hasMore: false, total: 0 }
    const api = async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(new Request(input, init).url).pathname
      return Response.json(path.endsWith("-runs") ? empty : [])
    }
    client.setConfig({ fetch: Object.assign(api, { preconnect: fetch.preconnect }) })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(getAuthSessionQueryKey(), { authenticated: false, authEnabled: false })
    const view = render(
      <QueryClientProvider client={queryClient}>
        <SectionsProvider visibility={undefined}>
          <MemoryRouter initialEntries={["/observability/runs?workflow=nightly&status=failed"]}>
            <ObservabilityRunsPage />
            <Location />
          </MemoryRouter>
        </SectionsProvider>
      </QueryClientProvider>
    )

    // The filters match nothing, and the page says so rather than claim there are no runs.
    await view.findByText("No runs match")
    fireEvent.click(view.getByRole("tab", { name: "Actions" }))
    await waitFor(() =>
      expect(view.getByTestId("location").textContent).toBe("/observability/runs?kind=actions")
    )
    // The action list's first read is still settling; let it land while the DOM is still here.
    await view.findByText("No runs yet")
    view.unmount()
    queryClient.clear()
  })
})

describe("AI usage", () => {
  // The server's refusal names the principal and is written for logs. Removal proof: drop the 403
  // branch from useLoadFailure and the page shows that message instead.
  test("says what grant a refused person lacks, not the server's message", async () => {
    const refusal = "[Sixb] Principal 'usr_1' is not allowed to observe project AI usage."
    const api = async () => Response.json({ error: refusal }, { status: 403 })
    client.setConfig({ fetch: Object.assign(api, { preconnect: fetch.preconnect }) })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(getAuthSessionQueryKey(), { authenticated: false, authEnabled: false })
    const view = render(
      <QueryClientProvider client={queryClient}>
        <SectionsProvider visibility={undefined}>
          <MemoryRouter initialEntries={["/observability/ai-usage"]}>
            <ObservabilityAiUsagePage />
          </MemoryRouter>
        </SectionsProvider>
      </QueryClientProvider>
    )

    expect(
      await view.findByText(
        "Seeing AI usage takes the AI usage observe grant, can.observe(agent.usage), in one of your roles."
      )
    ).toBeDefined()
    expect(view.queryByText(refusal)).toBeNull()
    view.unmount()
    queryClient.clear()
  })
})

describe("Logs", () => {
  // The stream says no only by closing, then reconnects every second. Removal proof: open the
  // stream without waiting for useLogsAccess and the socket opens; skip the 403 and the page waits.
  test("tell a refused person what they lack, and open no stream", async () => {
    const opened = sockets?.opened.length ?? 0
    const api = async () => Response.json({ error: "Missing capability" }, { status: 403 })
    client.setConfig({ fetch: Object.assign(api, { preconnect: fetch.preconnect }) })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(getAuthSessionQueryKey(), { authenticated: false, authEnabled: false })
    const view = render(
      <QueryClientProvider client={queryClient}>
        <SectionsProvider visibility={undefined}>
          <MemoryRouter initialEntries={["/observability/logs"]}>
            <ObservabilityLogsPage />
          </MemoryRouter>
        </SectionsProvider>
      </QueryClientProvider>
    )

    expect(
      await view.findByText("Seeing logs takes can.observe(project.logs) in one of your roles.")
    ).toBeDefined()
    expect(sockets?.opened.length ?? 0).toBe(opened)
    view.unmount()
    queryClient.clear()
  })
})

describe("Activity", () => {
  const visit = {
    id: "visit_1",
    actor: { type: "user", userId: "usr_1" },
    attribution: { source: "newsletter", campaign: "launch" },
    startedAt: "2026-10-02T09:00:00.000Z",
    lastSeenAt: "2026-10-02T09:20:00.000Z",
    pageViews: 2,
    interactions: 3,
  }
  const sharedVisit = {
    id: "visit_2",
    actor: { type: "share", grantId: "shr_1" },
    attribution: {},
    startedAt: "2026-10-02T08:00:00.000Z",
    lastSeenAt: "2026-10-02T08:05:00.000Z",
    pageViews: 0,
    interactions: 0,
  }
  const namedShare = {
    ...sharedVisit,
    id: "visit_3",
    actor: { type: "share", grantId: "shr_2", definitionId: "invoiceShare" },
  }

  function activityApi(requests: string[]) {
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url)
      requests.push(`${url.pathname}${url.search}`)
      switch (url.pathname) {
        case "/api/activity/summary":
          return Response.json({ users: 1, visits: 2, sharedVisits: 1, pageViews: 2 })
        case "/api/activity/users":
          // A second page, behind the first, shows the list does not stop at one.
          return Response.json(
            url.searchParams.get("beforeId") === "usr_1"
              ? {
                  users: [
                    {
                      userId: "usr_2",
                      displayName: "Blake",
                      lastSeenAt: sharedVisit.lastSeenAt,
                      visits: 1,
                      pageViews: 1,
                    },
                  ],
                  hasMore: false,
                }
              : {
                  users: [
                    {
                      userId: "usr_1",
                      displayName: "Alex",
                      lastSeenAt: visit.lastSeenAt,
                      visits: 1,
                      pageViews: 2,
                    },
                  ],
                  hasMore: true,
                }
          )
        case "/api/activity/visits":
          return Response.json({ visits: [visit, sharedVisit, namedShare], hasMore: false })
        case "/api/activity/visits/visit_1/timeline":
          return Response.json({
            visit,
            connection: {
              type: "session",
              device: { browser: "Chrome", os: "macOS" },
              status: "active",
              createdAt: "2026-10-02T08:30:00.000Z",
            },
            entries: [
              { kind: "page", at: visit.startedAt, sequence: 1, route: "/invoices" },
              {
                kind: "interaction",
                at: "2026-10-02T09:00:30.000Z",
                sequence: 2,
                name: "invoices.export",
                route: "/invoices",
              },
              {
                kind: "action",
                at: "2026-10-02T09:01:00.000Z",
                executionId: "exe_1",
                actionId: "markPaid",
                runId: "act_1",
                status: "succeeded",
                runVisible: true,
                object: { objectTypeId: "Invoice", primaryId: "inv-1" },
              },
              {
                kind: "action",
                at: "2026-10-02T09:02:00.000Z",
                executionId: "exe_2",
                actionId: "approvePayroll",
                runId: "act_2",
                status: "incomplete",
                runVisible: false,
              },
              {
                kind: "action",
                at: "2026-10-02T09:02:30.000Z",
                executionId: "exe_3",
                actionId: "archiveInvoice",
                runId: "act_3",
                status: "succeeded",
                runVisible: false,
              },
              {
                kind: "agent",
                at: "2026-10-02T09:03:00.000Z",
                executionId: "exe_4",
                runId: "run_1",
                threadId: "thr_1",
                status: "succeeded",
                messages: 3,
                cost: {
                  amounts: [{ currency: "USD", amountNanos: "40000000" }],
                  ratedCallCount: 2,
                  unpriceableCallCount: 0,
                  unvaluedCallCount: 0,
                },
              },
              { kind: "page", at: visit.lastSeenAt, sequence: 3, route: "/invoices/:id" },
            ],
            truncated: true,
          })
        case "/api/activity/connections":
          // Two pages: the cursor is the server's, passed back as is.
          return Response.json(
            url.searchParams.get("cursor") === "next-page"
              ? {
                  connections: [
                    {
                      type: "session",
                      device: {},
                      clientName: "sixb CLI",
                      status: "revoked",
                      createdAt: "2026-10-01T08:00:00.000Z",
                      visits: 0,
                      latestVisits: [],
                    },
                  ],
                }
              : {
                  connections: [
                    {
                      type: "session",
                      device: { browser: "Chrome", os: "macOS" },
                      status: "active",
                      createdAt: "2026-10-02T08:30:00.000Z",
                      lastSeenAt: visit.lastSeenAt,
                      visits: 7,
                      latestVisits: [visit],
                    },
                  ],
                  nextCursor: "next-page",
                }
          )
        case "/api/activity/calendar":
          return Response.json({
            userId: "usr_1",
            year: 2026,
            days: [{ day: "2026-10-02", visits: 1, pageViews: 2 }],
          })
        default:
          return Response.json({ error: "Not found" }, { status: 404 })
      }
    }
  }

  function renderActivity(path: string) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(getAuthSessionQueryKey(), { authenticated: false, authEnabled: false })
    const view = render(
      <QueryClientProvider client={queryClient}>
        <SectionsProvider visibility={undefined}>
          <MemoryRouter initialEntries={[path]}>
            <ObservabilityActivityPage />
            <Location />
          </MemoryRouter>
        </SectionsProvider>
      </QueryClientProvider>
    )
    return { view, queryClient }
  }

  // Removal proof: drop `denied` from the page's useLoadFailure call; the generic refusal shows.
  test("tells a refused person which grant reads activity", async () => {
    const api = async () => Response.json({ error: "[Sixb] not allowed" }, { status: 403 })
    client.setConfig({ fetch: Object.assign(api, { preconnect: fetch.preconnect }) })
    const { view, queryClient } = renderActivity("/observability/activity")

    expect(
      await view.findByText(
        "Seeing activity takes can.observe(project.activity) in one of your roles."
      )
    ).toBeDefined()
    view.unmount()
    queryClient.clear()
  })

  test("lists visits by name, opens a visit's timeline, and a user's calendar opens a day", async () => {
    const requests: string[] = []
    client.setConfig({
      fetch: Object.assign(activityApi(requests), { preconnect: fetch.preconnect }),
    })
    const { view, queryClient } = renderActivity("/observability/activity?user=usr_1&year=2026")

    // The visit reads with the account's name; a shared link stays anonymous.
    // With a user chosen, a row is named by its time, in UTC, not by the user again.
    const row = await view.findByRole("button", { name: /UTC.*2 page views/ })
    expect(row.textContent).not.toContain("Alex")
    expect(row.textContent).toContain("Oct 2 · 9:00 AM–9:20 AM UTC")
    fireEvent.click(row)
    const steps = await view.findByRole("list", { name: "Steps" })
    expect(within(steps).getByText("/invoices/:id")).toBeDefined()
    expect(within(steps).getByText("9:20:00 AM")).toBeDefined()
    expect(view.getByText("launch")).toBeDefined()
    await waitFor(() => expect(view.getByTestId("location").textContent).toContain("visit=visit_1"))

    const day = await view.findByRole("button", { name: /1 visit, 2 page views/ })
    fireEvent.click(day)
    await waitFor(() =>
      expect(view.getByTestId("location").textContent).toContain("day=2026-10-02")
    )
    // A chosen day reads exactly that UTC day.
    await waitFor(() =>
      expect(
        requests.some((request) =>
          request.includes("from=2026-10-02T00%3A00%3A00.000Z&to=2026-10-03T00%3A00%3A00.000Z")
        )
      ).toBe(true)
    )
    view.unmount()
    queryClient.clear()
  })

  test("a visit's timeline filters by kind and links recorded runs and readable objects", async () => {
    client.setConfig({
      fetch: Object.assign(activityApi([]), { preconnect: fetch.preconnect }),
    })
    const { view, queryClient } = renderActivity(
      "/observability/activity?user=usr_1&year=2026&visit=visit_1"
    )

    const steps = () => within(view.getByRole("list", { name: "Steps" }))
    expect(await view.findByRole("list", { name: "Steps" })).toBeDefined()
    expect(view.getByRole("link", { name: "Open the run of Mark Paid" }).getAttribute("href")).toBe(
      "/observability/runs/actions/act_1"
    )
    expect(view.getByRole("link", { name: "Invoice · inv-1" }).getAttribute("href")).toBe(
      "/objects/Invoice/inv-1"
    )
    // A run without a recorded outcome, or one the viewer may not read, has no page to open.
    expect(view.getByText("Approve Payroll").closest("a")).toBeNull()
    expect(view.getByText("Archive Invoice").closest("a")).toBeNull()
    expect(view.getByText("Not finished")).toBeDefined()
    expect(view.getByText("3 messages")).toBeDefined()
    expect(view.getByText("$0.04")).toBeDefined()
    expect(view.getAllByText("Chrome · macOS").length).toBeGreaterThan(0)

    // Two steps: /invoices holds the interaction and the runs, /invoices/:id nothing.
    const [invoices, invoice] = view.getByRole("list", { name: "Steps" }).children
    expect(invoices?.textContent).toContain("invoices.export")
    expect(invoices?.textContent).toContain("Mark Paid")
    expect(invoice?.textContent).toContain("/invoices/:id")
    expect(invoice?.textContent).not.toContain("Mark Paid")
    // The visit's header counts its steps, after its time, with how long it lasted.
    expect(view.getByText("2 steps").parentElement?.parentElement?.textContent).toBe(
      "·Oct 2 · 9:00 AM–9:20 AM UTC·2 steps·20m"
    )

    // A kind keeps the steps holding it, each with that kind only; Pages, the page views alone.
    fireEvent.click(view.getByRole("tab", { name: /Interactions/ }))
    expect(steps().getByText("invoices.export")).toBeDefined()
    expect(steps().queryByText("Mark Paid")).toBeNull()
    expect(steps().queryByText("/invoices/:id")).toBeNull()

    fireEvent.click(view.getByRole("tab", { name: /Actions/ }))
    expect(steps().getByText("/invoices")).toBeDefined()
    expect(steps().queryByText("/invoices/:id")).toBeNull()
    expect(steps().queryByText("invoices.export")).toBeNull()
    expect(steps().getByText("Mark Paid")).toBeDefined()
    expect(steps().queryByText("3 messages")).toBeNull()

    fireEvent.click(view.getByRole("tab", { name: /Pages/ }))
    expect(steps().getByText("/invoices/:id")).toBeDefined()
    expect(steps().queryByText("invoices.export")).toBeNull()
    expect(steps().queryByText("Mark Paid")).toBeNull()

    fireEvent.click(view.getByRole("tab", { name: /Workflows/ }))
    expect(view.getByText("Nothing of this kind in this visit.")).toBeDefined()

    expect(
      view.getByText(
        "This visit did more than the timeline shows: it stops after 200 page views and interactions, or 200 recorded executions."
      )
    ).toBeDefined()

    // The user's connections: each sign-in, with its latest visits, then the older ones.
    expect(await view.findByText("7 visits")).toBeDefined()
    expect(view.getByText("6 earlier visits")).toBeDefined()
    expect(view.queryByText("sixb CLI")).toBeNull()
    fireEvent.click(view.getByRole("button", { name: "Load more connections" }))
    expect(await view.findByText("sixb CLI")).toBeDefined()
    expect(view.getByText("Revoked")).toBeDefined()
    expect(view.queryByRole("button", { name: "Load more connections" })).toBeNull()
    view.unmount()
    queryClient.clear()
  })

  // The filter is a popover, which happy-dom cannot open (see sections.test.tsx), so this drives
  // the hook it lists. Removal proof: return undefined from getNextPageParam; Blake never loads.
  test("the user filter pages through every user of the period", async () => {
    const requests: string[] = []
    client.setConfig({
      fetch: Object.assign(activityApi(requests), { preconnect: fetch.preconnect }),
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const period = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-08T00:00:00.000Z" }
    const { result } = renderHook(() => useActivityUsers(period), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    })

    await waitFor(() => expect(result.current.hasMore).toBe(true))
    act(() => result.current.more())
    await waitFor(() => expect([...result.current.names.values()]).toEqual(["Alex", "Blake"]))
    expect(result.current.hasMore).toBe(false)
    queryClient.clear()
  })

  // Removal proof: invalidate every activity query as well as moving the period; each period
  // query then loads twice.
  test("Refresh loads each query once", async () => {
    const requests: string[] = []
    client.setConfig({
      fetch: Object.assign(activityApi(requests), { preconnect: fetch.preconnect }),
    })
    const { view, queryClient } = renderActivity("/observability/activity")
    // Interactions count beside page views, only when there are some.
    await view.findByRole("button", { name: /Alex.*2 page views.*3 interactions/ })
    expect(view.queryByText(/0 interactions/)).toBeNull()
    // A shared link has no account: it reads as one, told apart by the end of its id.
    expect(view.getAllByText("Shared link")).toHaveLength(2)
    // A link is named by its share, or by the end of its id once the grant is gone.
    expect(view.getByText("invoiceShare")).toBeDefined()
    expect(view.getByText("Link ending shr1")).toBeDefined()
    const summaries = () =>
      requests.filter((request) => request.startsWith("/api/activity/summary"))
    const before = summaries().length

    fireEvent.click(view.getByRole("button", { name: "Refresh" }))
    await waitFor(() => expect(summaries().length).toBe(before + 1))
    await Bun.sleep(20)
    expect(summaries().length).toBe(before + 1)
    view.unmount()
    queryClient.clear()
  })
})

describe("a visit's steps", () => {
  const routes = ["/", "/invoices", "/", "/invoices", "/reports", "/", "/team", "/", "/agents", "/"]
  const startedAt = Date.parse("2026-10-02T09:00:00.000Z")
  const entries: GetActivityVisitTimelineResponse["entries"] = routes.map((route, index) => ({
    kind: "page",
    at: new Date(startedAt + index * 60_000).toISOString(),
    sequence: index + 1,
    route,
  }))
  const visit = {
    id: "visit_1",
    actor: { type: "user", userId: "usr_1" },
    attribution: {},
    startedAt: entries[0]?.at ?? "",
    lastSeenAt: new Date(startedAt + 9 * 60_000 + 30_000).toISOString(),
    pageViews: routes.length,
    interactions: 0,
  } as const

  // Removal proof: count views per visit instead of per route, and "/" reads as a 10th time.
  test("a route viewed again says so; the last step ends where the visit did", () => {
    const view = render(
      <MemoryRouter>
        <VisitEntries timeline={{ visit, entries, truncated: false }} />
      </MemoryRouter>
    )

    const steps = view.getByRole("list", { name: "Steps" })
    // "/" five times, "/invoices" twice.
    expect(within(steps).getAllByText("2nd time")).toHaveLength(2)
    expect(within(steps).getByText("5th time")).toBeDefined()
    // The last step lasts until the visit's last activity, where it ended.
    expect(steps.lastElementChild?.textContent).toContain("30s · end")
  })
})
