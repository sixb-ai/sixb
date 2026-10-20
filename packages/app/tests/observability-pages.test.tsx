import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { client, type GetActionRunResponse } from "@sixb/client"
import { getAuthSessionQueryKey } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, waitFor } from "@testing-library/react"
import { MemoryRouter, useLocation } from "react-router-dom"
import { SectionsProvider } from "../src/pages"
import {
  effectsOutcomeWaitMs,
  effectsState,
  effectsWaitRemainingMs,
} from "../src/pages/observability/action-run"
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
  // pending, and its page polls forever.
  test("are waited for only a while after the run ended", () => {
    expect(effectsState(run(), true, finished + 1_000)).toBe("pending")
    expect(effectsState(run(), true, finished + effectsOutcomeWaitMs)).toBe("unrecorded")
  })

  // The page draws again after this long, since its last poll changes nothing. Removal proof:
  // return a shorter wait and the page shows "pending" once more, then never again.
  test("stop being waited for exactly when no outcome is expected", () => {
    const now = finished + 1_000
    const remaining = effectsWaitRemainingMs(run(), now)
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
