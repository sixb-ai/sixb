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
  branchStatus,
  branchStep,
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

function renderPage(list: ListBranchesResponse | null, path = "/console/branches") {
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
      branches: true,
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
    expect(branchStatus(branch({ state: "stopped" }))).toBe("starting")
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
    expect(view.getByText('source: { repository: "acme/shop" }')).toBeDefined()
    expect(view.queryByRole("button", { name: "New branch" })).toBeNull()
  })

  test("lists each branch with its status, data age and who opened it", () => {
    const { view } = renderPage({
      branches: [
        branch(),
        branch({ name: "fix/driver-hours", wanted: "stopped", state: "stopped" }),
      ],
      unavailable: null,
    })

    const ready = within(rowOf(view, "feature/route-planner"))
    expect(ready.getByText("Ready")).toBeDefined()
    expect(ready.getByText("Production data from 2 hours ago")).toBeDefined()
    expect(ready.getByText("Opened by you")).toBeDefined()
    expect(ready.getByRole("button", { name: "Open" })).toBeDefined()

    const stopped = within(rowOf(view, "fix/driver-hours"))
    expect(stopped.getByText("Stopped")).toBeDefined()
    expect(stopped.getByRole("button", { name: "Start" })).toBeDefined()
  })

  test("shows the steps of a branch starting, the current one marked", () => {
    const { view } = renderPage({ branches: [branch({ state: "copying" })], unavailable: null })

    const steps = view.getByRole("list", { name: "Progress" })
    expect(
      within(steps)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    ).toEqual(["Preparing machine(Done)", "Copying data(In progress)", "Starting(Not started)"])
    // Nothing to open yet: the steps say how far it is.
    expect(view.queryByRole("button", { name: "Open" })).toBeNull()
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

    expect(view.getByText("Needs attention")).toBeDefined()
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
      view.getByText("It runs without your project's dev values: production couldn't read them.")
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
    expect(within(dialog).getByText("Refresh feature/route-planner from production?")).toBeDefined()
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
  function renderBanner(project: unknown) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
    })
    queryClient.setQueryData(getProjectInfoQueryKey(), project)
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
    expect(within(bar).getByText("production data from 2 hours ago")).toBeDefined()
    expect(
      within(bar)
        .getByRole("link", { name: "Refresh feature/route-planner from production" })
        .getAttribute("href")
    ).toBe("https://app.northline.test/console/branches?branch=feature%2Froute-planner&refresh=1")
    expect(within(bar).getByRole("link", { name: "Back to production" }).getAttribute("href")).toBe(
      "https://app.northline.test"
    )
  })

  // A branch on a laptop has no production to refresh it from here: it says what it is, alone.
  test("on a branch production doesn't run, offers no way to production", () => {
    const view = renderBanner({
      id: "northline",
      locale: "en",
      timeZone: "UTC",
      branch: { name: "feature/route-planner", dataTakenAt: null, productionUrl: null },
    })

    expect(view.getByText("feature/route-planner")).toBeDefined()
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
