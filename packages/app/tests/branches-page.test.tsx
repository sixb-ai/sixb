import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { client, type ListBranchesResponse } from "@sixb/client"
import {
  getAuthSessionQueryKey,
  getProjectInfoQueryKey,
  listBranchesQueryKey,
} from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, waitFor, within } from "@testing-library/react"
import { useLayoutEffect } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { BranchBanner, ConsoleBranchesPage, SectionsProvider } from "../src/pages"
import {
  BRANCHES_POLL_MS,
  type Branch,
  branchesPollInterval,
  branchNameProblem,
  branchStatus,
  branchStep,
  WORKER_WAIT_MS,
} from "../src/pages/console/branches/branches"
import { installDom } from "./helpers/dom"

const browser = installDom([
  "document",
  "navigator",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLFormElement",
  "Event",
  "CustomEvent",
  "FocusEvent",
  "EventTarget",
  "MouseEvent",
  "KeyboardEvent",
  "PointerEvent",
  "MutationObserver",
  "getComputedStyle",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "localStorage",
])
const apiUrl = "https://api.sixb.test"
const originalConfig = client.getConfig()
client.setConfig({ baseUrl: apiUrl })

// Radix picks its layout effect when it loads, a no-op without a `document`: dialogs and menus
// then never open. It gets React's own for this file, and its own back after.
const radix = Bun.resolveSync("radix-ui", Bun.resolveSync("@sixb/ui/components", import.meta.dir))
const layoutEffect = Bun.resolveSync(
  "@radix-ui/react-use-layout-effect",
  Bun.resolveSync("@radix-ui/react-portal", Bun.resolveSync("@radix-ui/react-dialog", radix))
)
const loaded: typeof import("react").useLayoutEffect = (await import(layoutEffect)).useLayoutEffect
mock.module(layoutEffect, () => ({ useLayoutEffect }))

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  client.setConfig({ fetch: originalConfig.fetch })
})

afterAll(() => {
  client.setConfig({ baseUrl: originalConfig.baseUrl })
  mock.module(layoutEffect, () => ({ useLayoutEffect: loaded }))
})

const now = Date.now()
const ago = (ms: number) => new Date(now - ms).toISOString()

const ada = {
  id: "usr_ada",
  email: "ada@northline.test",
  displayName: "Ada Laurent",
  groupIds: ["developers"],
}

function branch(overrides: Partial<Branch> = {}): Branch {
  return {
    name: "feature/route-planner",
    wanted: "running",
    state: "ready",
    createdBy: ada.id,
    generation: 3,
    commit: "a".repeat(40),
    error: null,
    notices: [],
    data: {
      takenAt: ago(2 * 60 * 60_000),
      objects: 48_210,
      skipped: [],
      skippedDatasets: [],
      lakeSliceId: null,
    },
    refreshRequestedAt: null,
    openedAt: ago(3 * 60 * 60_000),
    lastSeenAt: ago(5 * 60_000),
    ...overrides,
  }
}

function answerWith(answer: (request: Request) => Response | Promise<Response>) {
  const seen: Request[] = []
  const api = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    seen.push(request.clone())
    return answer(request)
  }
  client.setConfig({ fetch: Object.assign(api, { preconnect: fetch.preconnect }) })
  return seen
}

function renderPage(
  list: ListBranchesResponse | null,
  path = "/console/branches",
  access: { readonly branches: boolean } = { branches: true }
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  })
  queryClient.setQueryData(getAuthSessionQueryKey(), {
    authenticated: true,
    user: ada,
    access: {
      members: false,
      serviceAccounts: false,
      usage: false,
      activity: false,
      console: true,
      logs: false,
      branches: access.branches,
    },
    session: { id: "ses_1", expiresAt: ago(-60 * 60_000) },
  })
  if (list) queryClient.setQueryData(listBranchesQueryKey(), list)
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SectionsProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="*" element={<ConsoleBranchesPage />} />
          </Routes>
        </MemoryRouter>
      </SectionsProvider>
    </QueryClientProvider>
  )
  return { view, queryClient }
}

describe("a branch's status", () => {
  test("says in plain words what a person can do with it", () => {
    expect(branchStatus(branch())).toBe("ready")
    expect(branchStatus(branch({ state: "stopped", openedAt: ago(10_000) }))).toBe("starting")
    // A minute on, nothing has picked it up: no worker runs branches.
    expect(branchStatus(branch({ state: "stopped", openedAt: ago(WORKER_WAIT_MS + 1) }))).toBe(
      "waiting"
    )
    expect(branchStatus(branch({ state: "copying" }))).toBe("starting")
    expect(branchStatus(branch({ wanted: "stopped", state: "stopped" }))).toBe("stopped")
    expect(branchStatus(branch({ wanted: "stopped" }))).toBe("stopping")
    expect(branchStatus(branch({ state: "failed" }))).toBe("attention")
    expect(branchStatus(branch({ wanted: "deleted" }))).toBe("deleting")
    expect(branchStatus(branch({ refreshRequestedAt: ago(1_000) }))).toBe("refreshing")
    // A refresh the copy already answered is over.
    expect(branchStatus(branch({ refreshRequestedAt: ago(3 * 60 * 60_000) }))).toBe("ready")
  })

  test("walks the steps of a branch on its way up", () => {
    expect(branchStep(branch({ state: "stopped" }))).toBe("preparing")
    expect(branchStep(branch({ state: "copying" }))).toBe("copying")
    expect(branchStep(branch({ state: "starting" }))).toBe("starting")
    expect(branchStep(branch())).toBeNull()
  })

  test("names what is wrong with a branch name", () => {
    expect(branchNameProblem("feature/route-planner")).toBeNull()
    expect(branchNameProblem("route planner")).toBe("spaces")
    expect(branchNameProblem("feature/")).toBe("invalid")
    expect(branchNameProblem("fix..hours")).toBe("invalid")
  })

  // Removal proof: return the settled interval always, and a starting branch waits 15 s a step.
  test("is read again every 2 s while a branch moves, every 15 s otherwise", () => {
    expect(branchesPollInterval([branch(), branch({ state: "copying" })])).toBe(
      BRANCHES_POLL_MS.moving
    )
    expect(branchesPollInterval([branch(), branch({ state: "failed" })])).toBe(
      BRANCHES_POLL_MS.settled
    )
  })
})

describe("Console › Branches", () => {
  test("says what a branch is and the one next step when there is none", () => {
    const { view } = renderPage({ branches: [], unavailable: null })

    expect(view.getByText("No branches yet")).toBeDefined()
    expect(view.getByRole("button", { name: "New branch" })).toBeDefined()
  })

  test("says what production lacks, and how to add it, before branches can run", () => {
    const { view } = renderPage({
      branches: [],
      unavailable: { code: "source", message: "the project's repository" },
    })

    expect(view.getByText("Branches aren't set up yet")).toBeDefined()
    expect(view.getByText('source: { repository: "your-org/your-repo" },')).toBeDefined()
    expect(view.getByRole("link", { name: "Setup guide" }).getAttribute("href")).toBe(
      "https://docs.sixb.ai/deployment/branches"
    )
    expect(view.queryByRole("button", { name: "New branch" })).toBeNull()
  })

  // Hiding the page protects no data: the page says why there is nothing, rather than leave.
  test("tells someone without the grant that they don't have access", () => {
    const { view } = renderPage({ branches: [branch()], unavailable: null }, "/console/branches", {
      branches: false,
    })

    expect(view.getByText("You don't have access to Branches. Ask a project admin.")).toBeDefined()
    expect(view.queryByText("feature/route-planner")).toBeNull()
  })

  // A refusal is no outage: nothing to try again.
  test("offers to try again after a failure, never after a refusal", async () => {
    answerWith(() => Response.json({ error: "Forbidden" }, { status: 403 }))
    const denied = renderPage(null)
    expect(
      await denied.view.findByText("You don't have access to Branches. Ask a project admin.")
    ).toBeDefined()
    expect(denied.view.queryByRole("button", { name: "Try again" })).toBeNull()
    denied.view.unmount()

    answerWith(() =>
      Response.json({ error: "The database didn't answer in time." }, { status: 500 })
    )
    const failed = renderPage(null)
    expect(await failed.view.findByText("The database didn't answer in time.")).toBeDefined()
    expect(failed.view.getByRole("button", { name: "Try again" })).toBeDefined()
  })

  test("lists each branch with its status, data age and who opened it", () => {
    const { view } = renderPage({
      branches: [
        branch(),
        branch({ name: "fix/driver-hours", wanted: "stopped", state: "stopped" }),
      ],
      unavailable: null,
    })

    // The pill is drawn twice, beside the name and, on a phone, before the facts: CSS shows one.
    const ready = within(rowOf(view, "feature/route-planner"))
    expect(ready.getAllByText("Ready")).toHaveLength(2)
    expect(ready.getByText("Production data from 2 hours ago")).toBeDefined()
    expect(ready.getAllByText("Started by you").length).toBeGreaterThan(0)
    expect(ready.getByText("Last opened 5 minutes ago")).toBeDefined()
    // A fact that doesn't fit on a wide screen drops out whole: the tooltip keeps them all.
    expect(
      rowOf(view, "feature/route-planner")
        .querySelector("[title*='Last opened']")
        ?.getAttribute("title")
    ).toBe("Production data from 2 hours ago · Started by you · Last opened 5 minutes ago")
    expect(ready.getByRole("button", { name: "Open" })).toBeDefined()

    const stopped = within(rowOf(view, "fix/driver-hours"))
    expect(stopped.getAllByText("Stopped")).toHaveLength(2)
    expect(stopped.getByRole("button", { name: "Start" })).toBeDefined()
  })

  test("shows the steps of a branch starting, the current one marked", () => {
    const { view } = renderPage({
      branches: [branch({ state: "copying", data: null, openedAt: ago(10_000) })],
      unavailable: null,
    })

    const steps = view.getByRole("list", { name: "Progress" })
    expect(
      within(steps)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    ).toEqual([
      "Preparing machine(Done)",
      "Copying data(In progress)",
      "Starting the app(Not started)",
    ])
    expect(view.getByText("Copying production data…")).toBeDefined()
    // Nothing to open yet: the steps say how far it is.
    expect(view.queryByRole("button", { name: "Open" })).toBeNull()
  })

  // A branch nothing picks up would otherwise spin forever. Removal proof: drop "waiting" from
  // `branchStatus`, and the page spins on with no word on why.
  test("says when nothing runs branches, who can fix it, and the command", () => {
    const { view } = renderPage({
      branches: [branch({ state: "stopped", data: null, openedAt: ago(5 * 60_000) })],
      unavailable: null,
    })

    expect(view.getAllByText("Waiting")).toHaveLength(2)
    expect(
      view.getByText(
        "Nothing is running branches on production yet. Ask a developer to start the branch worker:"
      )
    ).toBeDefined()
    expect(view.getByText("sixb worker branches")).toBeDefined()
    expect(view.container.querySelector("[class*='animate-spin']")).toBeNull()
  })

  // Removal proof: drop the toast from the status effect, and a branch turns ready unseen.
  test("says when a branch it was watching is ready, and offers to open it", async () => {
    const starting = branch({ state: "starting", openedAt: ago(10_000) })
    const { view, queryClient } = renderPage({ branches: [starting], unavailable: null })

    act(() => {
      queryClient.setQueryData(listBranchesQueryKey(), {
        branches: [{ ...starting, state: "ready" }],
        unavailable: null,
      })
    })

    expect(await view.findByText("feature/route-planner: Ready")).toBeDefined()
    expect(await view.findByText("feature/route-planner is ready")).toBeDefined()
  })

  test("says what needs attention first, with the error folded under Details", () => {
    const { view } = renderPage({
      branches: [
        branch({
          state: "failed",
          error: { message: "SyntaxError: Unexpected token '}'", file: "ontology/route.ts" },
        }),
      ],
      unavailable: null,
    })

    expect(view.getAllByText("Needs attention")).toHaveLength(2)
    expect(view.getByText("The branch's code didn't start.")).toBeDefined()
    expect(view.getByText("ontology/route.ts")).toBeDefined()
    expect(view.queryByText("SyntaxError: Unexpected token '}'")).toBeNull()

    fireEvent.click(view.getByRole("button", { name: "Details" }))
    expect(view.getByText("SyntaxError: Unexpected token '}'")).toBeDefined()
  })

  test("says, folded, which types and datasets weren't copied and why", () => {
    const { view } = renderPage({
      branches: [
        branch({
          notices: [{ code: "no-dev-env", message: "No dev values." }],
          data: {
            ...branch().data!,
            skipped: [
              { objectTypeId: "payslip", reason: "the person who took it cannot read this type" },
              {
                objectTypeId: "route",
                reason: "property 'stops' is required on the branch but not in production",
              },
            ],
            skippedDatasets: [
              { datasetId: "driver_salaries", reason: "missing_clearance", columns: ["amount"] },
            ],
          },
        }),
      ],
      unavailable: null,
    })

    expect(
      view.getByText(
        "Some connected services may not work here: production can't read your project's development settings. Ask a developer to give production access to them."
      )
    ).toBeDefined()
    fireEvent.click(view.getByRole("button", { name: "2 types and 1 dataset weren't copied" }))
    expect(view.getByText("Ada Laurent can't read it in production.")).toBeDefined()
    expect(
      view.getByText("Its definition changed on this branch, so production's rows no longer fit.")
    ).toBeDefined()
    expect(
      view.getByText("Ada Laurent can't read every column (amount), so none of it was copied.")
    ).toBeDefined()
  })

  // The banner of a branch's app links here: the page asks, rather than refreshing on a link.
  test("asks before a refresh, saying what is lost, and refreshes once confirmed", async () => {
    const seen = answerWith((request) =>
      request.method === "POST"
        ? Response.json(branch({ refreshRequestedAt: ago(0) }), { status: 202 })
        : Response.json({ branches: [branch()], unavailable: null })
    )
    const { view } = renderPage(
      { branches: [branch()], unavailable: null },
      "/console/branches?branch=feature%2Froute-planner&refresh=1"
    )

    const dialog = await view.findByRole("alertdialog")
    expect(within(dialog).getByRole("heading").textContent).toBe(
      "Refresh feature/route-planner from production?"
    )
    expect(
      within(dialog).getByText(
        "It takes a new copy of what you see in production now. Changes made on this branch are discarded."
      )
    ).toBeDefined()

    fireEvent.click(within(dialog).getByRole("button", { name: "Refresh" }))
    await waitFor(() =>
      expect(seen.some((request) => request.url.endsWith("/api/branches/refresh"))).toBe(true)
    )
    const refresh = seen.find((request) => request.url.endsWith("/api/branches/refresh"))!
    expect(await refresh.json()).toEqual({ name: "feature/route-planner" })
  })

  // The tab opens on the click, or the browser blocks it, and only then is the person signed in.
  // The branch's page gets no handle on the Console's tab. Removal proof: open the tab after the
  // sign-in answers, and `window.open` is called outside the click.
  test("opens a ready branch in a new tab, signed in through production", async () => {
    let answer!: (response: Response) => void
    const signedIn = new Promise<Response>((resolve) => {
      answer = resolve
    })
    const seen = answerWith((request) =>
      request.url.endsWith("/api/branches/sign-in") ? signedIn : Response.json({})
    )
    const tab = {
      opener: {} as unknown,
      closed: false,
      document: browser.document,
      location: { replace: mock((_url: string) => {}) },
      close: mock(() => {}),
      matchMedia: () => ({ matches: false }),
    }
    const open = mock(() => tab)
    const original = browser.open
    ;(browser as unknown as { open: typeof open }).open = open
    try {
      const { view } = renderPage({ branches: [branch()], unavailable: null })
      fireEvent.click(view.getByRole("button", { name: "Open" }))
      expect(open).toHaveBeenCalledTimes(1)

      await act(async () => {
        answer(Response.json({ url: "https://feature-route-planner.northline-preview.test/x" }))
      })
      await waitFor(() => expect(tab.location.replace).toHaveBeenCalled())
      expect(tab.location.replace.mock.calls[0]?.[0]).toBe(
        "https://feature-route-planner.northline-preview.test/x"
      )
      expect(tab.opener).toBeNull()
      expect(await seen[0]?.json()).toEqual({ name: "feature/route-planner" })
    } finally {
      ;(browser as unknown as { open: typeof original }).open = original
    }
  })
})

describe("the branch bar", () => {
  function renderBanner(
    project: unknown,
    access: { readonly branches: boolean } = { branches: true }
  ) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
    })
    queryClient.setQueryData(getProjectInfoQueryKey(), project)
    queryClient.setQueryData(getAuthSessionQueryKey(), {
      authenticated: true,
      user: ada,
      access: {
        members: false,
        serviceAccounts: false,
        usage: false,
        activity: false,
        console: true,
        logs: false,
        branches: access.branches,
      },
      session: { id: "ses_1", expiresAt: ago(-60 * 60_000) },
    })
    return render(
      <QueryClientProvider client={queryClient}>
        <BranchBanner />
      </QueryClientProvider>
    )
  }

  test("draws nothing in production", () => {
    const view = renderBanner({ id: "northline", locale: "en", timeZone: "UTC" })
    expect(view.container.innerHTML).toBe("")
  })

  test("names the branch and its data's age, with Refresh and the way back to production", () => {
    const view = renderBanner({
      id: "northline",
      locale: "en",
      timeZone: "UTC",
      branch: {
        name: "feature/route-planner",
        dataTakenAt: ago(2 * 60 * 60_000),
        productionUrl: "https://app.northline.test",
      },
    })

    const bar = view.getByRole("complementary", { name: "Branch feature/route-planner" })
    expect(within(bar).getByText("Production data from 2 hours ago")).toBeDefined()
    // A phone's bar says it shorter.
    expect(within(bar).getByText("Data · 2 h ago")).toBeDefined()
    expect(
      within(bar)
        .getByRole("link", { name: "Refresh feature/route-planner from production" })
        .getAttribute("href")
    ).toBe("https://app.northline.test/console/branches?branch=feature%2Froute-planner&refresh=1")
    expect(within(bar).getByRole("link", { name: "Back to production" }).getAttribute("href")).toBe(
      "https://app.northline.test"
    )
  })

  // Refreshing takes the grant in production: the bar offers it to those who hold it alone.
  // Removal proof: drop `canRefresh` from `refreshUrl` (`branch-banner.tsx`).
  test("offers Refresh only to those who may refresh the branch", () => {
    const view = renderBanner(
      {
        id: "northline",
        locale: "en",
        timeZone: "UTC",
        branch: {
          name: "feature/route-planner",
          dataTakenAt: ago(2 * 60 * 60_000),
          productionUrl: "https://app.northline.test",
        },
      },
      { branches: false }
    )

    expect(view.queryByRole("link", { name: /Refresh/ })).toBeNull()
    expect(view.getByRole("link", { name: "Back to production" })).toBeDefined()
  })

  // A branch on a laptop has no production to refresh it from here: it says what it is, alone.
  test("on a branch production doesn't run, offers no way to production", () => {
    const view = renderBanner({
      id: "northline",
      locale: "en",
      timeZone: "UTC",
      branch: { name: "feature/route-planner", dataTakenAt: null, productionUrl: null },
    })

    expect(view.getAllByText("feature/route-planner").length).toBeGreaterThan(0)
    expect(view.queryAllByRole("link")).toEqual([])
  })

  test("folds away into a button, and stays folded for this branch", () => {
    const project = {
      id: "northline",
      locale: "en",
      timeZone: "UTC",
      branch: { name: "feature/route-planner", dataTakenAt: null, productionUrl: null },
    }
    const view = renderBanner(project)
    fireEvent.click(view.getByRole("button", { name: "Hide the branch bar" }))
    expect(view.queryByRole("complementary")).toBeNull()
    view.unmount()

    const again = renderBanner(project)
    fireEvent.click(
      again.getByRole("button", { name: "Show the bar of branch feature/route-planner" })
    )
    expect(again.getByRole("complementary")).toBeDefined()
  })
})

function rowOf(view: ReturnType<typeof render>, name: string): HTMLElement {
  const label = view.getByText(name)
  const row = label.closest<HTMLElement>("[data-branch]")
  if (!row) throw new Error(`No row for ${name}`)
  return row
}
