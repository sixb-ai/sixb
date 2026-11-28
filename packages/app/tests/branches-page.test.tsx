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
/** Production's time as the list says it. */
const NOW = new Date(now).toISOString()

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
    remoteError: null,
    notices: [],
    data: {
      takenAt: ago(2 * 60 * 60_000),
      objects: 48_210,
      skipped: [],
      partial: [],
      refusedByDeploy: [],
      unchecked: [],
      migrated: [],
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

/** The list as the page reads it: its branches may carry what a newer server sends. */
type BranchList = Omit<ListBranchesResponse, "branches"> & { readonly branches: readonly Branch[] }

function renderPage(
  list: BranchList | null,
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

  // A stopped branch refreshed long after it was opened: nothing took the refresh up, and it once
  // spun as "Refreshing" for good. Red check: measure from `openedAt` alone in `unclaimed`, or
  // check `refreshPending` before it in `branchStatus`.
  test("waits from the refresh it was last asked for", () => {
    const refreshed = (at: number) =>
      branch({ state: "stopped", openedAt: ago(3 * 60 * 60_000), refreshRequestedAt: ago(at) })

    expect(branchStatus(refreshed(10_000))).toBe("refreshing")
    expect(branchStatus(refreshed(WORKER_WAIT_MS + 1))).toBe("waiting")
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
    const { view } = renderPage({ branches: [], unavailable: null, now: NOW })

    expect(view.getByText("No branches yet")).toBeDefined()
    expect(view.getByRole("button", { name: "New branch" })).toBeDefined()
  })

  test("says what production lacks, and how to add it, before branches can run", () => {
    const { view } = renderPage({
      branches: [],
      unavailable: { code: "source", message: "the project's repository" },
      now: NOW,
    })

    expect(view.getByText("Branches aren't set up yet")).toBeDefined()
    expect(view.getByText('source: { repository: "your-org/your-repo" },')).toBeDefined()
    expect(view.getByRole("link", { name: "Setup guide" }).getAttribute("href")).toBe(
      "https://docs.sixb.ai/deployment/branches"
    )
    expect(view.queryByRole("button", { name: "New branch" })).toBeNull()
  })

  // smolvm serves branches on production's loopback: Open would lead nowhere. Red check: drop the
  // `preview-domain` case from `branchesUnavailable` (`core/branches/hosting.ts`), and the worker
  // test that asks for it fails; drop its line from `setup`, and this one does.
  test("asks for a preview domain when the machines can't be reached", () => {
    const { view } = renderPage({
      branches: [],
      unavailable: { code: "preview-domain", message: "a preview domain" },
      now: NOW,
    })

    expect(
      view.getByText(
        "These machines can only be reached from production's own server. Give branches a web address of their own in sixb.config.ts:"
      )
    ).toBeDefined()
    expect(
      view.getByText(
        'source: { repository: "your-org/your-repo", previewDomain: "your-preview.dev" },'
      )
    ).toBeDefined()
  })

  // Hiding the page protects no data: the page says why there is nothing, rather than leave.
  test("tells someone without the grant that they don't have access", () => {
    const { view } = renderPage(
      { branches: [branch()], unavailable: null, now: NOW },
      "/console/branches",
      {
        branches: false,
      }
    )

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
      now: NOW,
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
      now: NOW,
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

  // A branch nothing picks up would otherwise spin forever. Its worker may be busy, restarting or
  // missing: the page says what it knows, a wait, and what to check. Removal proof: drop
  // "waiting" from `branchStatus`, and the page spins on with no word on why.
  test("says a branch waits for a free worker, and what to check if it lasts", () => {
    const { view } = renderPage({
      branches: [branch({ state: "stopped", data: null, openedAt: ago(5 * 60_000) })],
      unavailable: null,
      now: NOW,
    })

    expect(view.getAllByText("Waiting")).toHaveLength(2)
    expect(
      view.getByText(
        "Waiting for a free worker: the branch starts as soon as one is free. If it keeps waiting, ask a developer to check the branch worker:"
      )
    ).toBeDefined()
    expect(view.getByText("sixb worker branches")).toBeDefined()
    expect(view.container.querySelector("[class*='animate-spin']")).toBeNull()
  })

  // Production wrote the branch's times on its own clock: a browser five minutes ahead once said a
  // branch opened 10 s before was waiting. Red check: read `Date.now()` rather than the list's
  // `now` in `ConsoleBranchesPage`.
  test("measures a wait on production's clock, not the browser's", () => {
    const openedAt = ago(5 * 60_000)
    const { view } = renderPage({
      branches: [branch({ state: "stopped", data: null, openedAt })],
      unavailable: null,
      now: new Date(Date.parse(openedAt) + 10_000).toISOString(),
    })

    expect(view.getAllByText("Starting")).toHaveLength(2)
    expect(view.queryByText("Waiting")).toBeNull()
  })

  // The worker's last read of the repository failed: someone has to act, and nothing is on its
  // way. The row says so at once, as needing attention, rather than wait a minute and blame a
  // worker. Red check: drop the `remoteError` case from `branchStatus` (`branches.tsx`).
  test("says at once when production can't get the branch from the repository", () => {
    const { view } = renderPage({
      branches: [
        branch({
          state: "stopped",
          data: null,
          openedAt: ago(5_000),
          remoteError: "fatal: could not read Username for 'https://github.com'",
        }),
      ],
      unavailable: null,
      now: NOW,
    })

    expect(view.getAllByText("Needs attention")).toHaveLength(2)
    expect(
      view.getByText("Production can't get this branch from the git repository.")
    ).toBeDefined()
    expect(view.queryByRole("list", { name: "Progress" })).toBeNull()
    expect(view.queryByText("sixb worker branches")).toBeNull()

    fireEvent.click(view.getByRole("button", { name: "Details" }))
    expect(view.getByText("fatal: could not read Username for 'https://github.com'")).toBeDefined()
  })

  // Five branches waiting once said the same thing five times. Red check: show the callout under
  // every waiting row (`workerHint` in `ConsoleBranchesPage`).
  test("says once, above the list, that several branches wait for a free worker", () => {
    const waiting = (name: string) =>
      branch({ name, state: "stopped", data: null, openedAt: ago(5 * 60_000) })
    const { view } = renderPage({
      branches: [waiting("feature/a"), waiting("feature/b")],
      unavailable: null,
      now: NOW,
    })

    expect(view.getAllByText(/waiting for a free worker/)).toHaveLength(1)
    expect(view.getByText(/^2 branches are waiting for a free worker/)).toBeDefined()
    expect(view.getAllByText("sixb worker branches")).toHaveLength(1)
  })

  // Production closed the branch for what its data grew to: starting it again would close it
  // again, so its one action is a refresh. Red check: drop `closedForDatabase` from `BranchRow`.
  test("offers a refresh on a branch production stopped for its data", async () => {
    const { view } = renderPage({
      branches: [
        branch({
          wanted: "stopped",
          state: "stopped",
          // As production words it: the Console says it in its own words.
          notices: [
            {
              code: "database-limit",
              message:
                "This branch stopped: its data grew past 20 GB on production's database, its limit. Refresh it from production to start again from a new copy.",
            },
          ],
        }),
      ],
      unavailable: null,
      now: NOW,
    })

    expect(
      view.getByText(
        "Production stopped this branch: its data grew past its limit. Refresh it to start over from a new copy."
      )
    ).toBeDefined()
    expect(view.queryByRole("button", { name: "Start" })).toBeNull()
    fireEvent.click(view.getByRole("button", { name: "Refresh…" }))
    expect(within(await view.findByRole("alertdialog")).getByRole("heading").textContent).toBe(
      "Refresh feature/route-planner from production?"
    )
  })

  // Closed for its locks, or for reaching another database, it keeps its data: a refresh would
  // throw away what it wrote, so Start comes first and Refresh waits in the menu. Red check: test
  // `notice.code.startsWith("database-")` in `closedForDatabase` (`BranchRow`).
  test("offers Start on a branch production stopped for anything but its data", async () => {
    const { view } = renderPage({
      branches: [
        branch({
          wanted: "stopped",
          state: "stopped",
          notices: [
            {
              code: "database-closed",
              message:
                "This branch stopped: branches together held more database locks than production's database can spare, and this one held the most (900). Start it again to keep going.",
            },
          ],
        }),
      ],
      unavailable: null,
      now: NOW,
    })

    expect(
      view.getByText(
        "Production stopped this branch: it held up production's database, or its code reached a database it may not use. What it wrote is kept: start it to keep going."
      )
    ).toBeDefined()
    expect(view.getByRole("button", { name: "Start" })).toBeDefined()
    expect(view.queryByRole("button", { name: "Refresh…" })).toBeNull()

    await act(async () => {
      fireEvent.pointerDown(view.getByRole("button", { name: "More for feature/route-planner" }), {
        button: 0,
        ctrlKey: false,
        pointerType: "mouse",
      })
    })
    expect(view.getByRole("menuitem", { name: "Refresh from production…" })).toBeDefined()
  })

  // Removal proof: drop the toast from the status effect, and a branch turns ready unseen.
  test("says when a branch it was watching is ready, and offers to open it", async () => {
    const starting = branch({ state: "starting", openedAt: ago(10_000) })
    const { view, queryClient } = renderPage({ branches: [starting], unavailable: null, now: NOW })

    act(() => {
      queryClient.setQueryData(listBranchesQueryKey(), {
        branches: [{ ...starting, state: "ready" }],
        unavailable: null,
        now: NOW,
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
      now: NOW,
    })

    expect(view.getAllByText("Needs attention")).toHaveLength(2)
    expect(view.getByText("The branch's code didn't start.")).toBeDefined()
    expect(view.getByText("ontology/route.ts")).toBeDefined()
    expect(view.queryByText("SyntaxError: Unexpected token '}'")).toBeNull()

    fireEvent.click(view.getByRole("button", { name: "Details" }))
    expect(view.getByText("SyntaxError: Unexpected token '}'")).toBeDefined()
  })

  // Red check: in branches.tsx, pick each skip's sentence by its reason instead of its kind: the
  // migrating and conflicting types read as changed definitions.
  test("says, folded, what the copy left out, holds in part and migrated, each in plain words", () => {
    const deployLines = [
      "✗ route: 'stops' is now required, and 12 objects lack it: created without it or cleared by an edit.",
      "  Fill it in a migration:",
      '    defineMigration("route-stops", Route).fillProperty("stops", ({ object }) => …)',
    ]
    const { view } = renderPage({
      branches: [
        branch({
          notices: [{ code: "no-dev-env", message: "No dev values." }],
          data: {
            ...branch().data!,
            skipped: [
              {
                objectTypeId: "payslip",
                kind: "unreadable",
                reason: "the person who took it cannot read this type",
                findings: [],
              },
              {
                objectTypeId: "route",
                kind: "unfit",
                reason: "production's objects don't fit the branch's code",
                findings: deployLines,
              },
              {
                objectTypeId: "shift",
                kind: "migrating",
                reason: "production was applying a migration to it",
                findings: [],
              },
            ],
            skippedDatasets: [
              { datasetId: "driver_salaries", reason: "missing_clearance", columns: ["amount"] },
            ],
            partial: [
              { objectTypeId: "driver", hiddenPropertyIds: ["salary"], throughCondition: true },
            ],
            refusedByDeploy: [
              {
                objectTypeId: "vehicle",
                findings: ["✗ vehicle: 'plate' was removed, and 3 objects hold it."],
              },
            ],
            unchecked: [
              {
                objectTypeId: "payroll",
                lines: [
                  "payroll: 'iban' is now required: not checked, the copy holds none of its values.",
                ],
              },
            ],
            migrated: [{ objectTypeId: "job", migrationIds: ["job-gate-code"] }],
          },
        }),
      ],
      unavailable: null,
      now: NOW,
    })

    expect(
      view.getByText(
        "Some connected services may not work here: production can't read your project's development settings. Ask a developer to give production access to them."
      )
    ).toBeDefined()
    fireEvent.click(
      view.getByRole("button", {
        name: "3 types and 1 dataset weren't copied, 3 types copied in part, 1 type migrated",
      })
    )
    expect(view.getByText("Ada Laurent can't read it in production.")).toBeDefined()
    expect(
      view.getByText(
        "Its definition changed on this branch, and production's rows don't fit it: see why below."
      )
    ).toBeDefined()
    expect(
      view.getByText(
        "Production was updating it when the copy was taken. Refresh to copy it again."
      )
    ).toBeDefined()
    expect(
      view.getByText(
        "This branch removed some of its values, so they weren't copied. Production needs a migration to remove them too."
      )
    ).toBeDefined()
    expect(view.getByText("This branch's migrations updated its rows on this copy.")).toBeDefined()
    expect(
      view.getByText(
        "Some of this branch's changes to it couldn't be checked here: the copy doesn't hold the values they touch as production does."
      )
    ).toBeDefined()
    expect(
      view.getByText(
        "Ada Laurent can't read salary, so those values weren't copied. Ada Laurent reads only some of its rows: the others weren't copied."
      )
    ).toBeDefined()
    expect(
      view.getByText("Ada Laurent can't read every column (amount), so none of it was copied.")
    ).toBeDefined()

    // What a deploy prints is technical: folded under the type's own Details. Its sentences wrap;
    // the line to write is code, kept whole on a phone and scrolled in its own box.
    // Red check: in branches.tsx, render `DetailLines` as one wrapping block: the code is no
    // longer an element of its own.
    expect(view.queryByText(/defineMigration/)).toBeNull()
    fireEvent.click(view.getAllByRole("button", { name: "Details" })[0]!)
    const code = view.getByText(/^defineMigration\("route-stops"/)
    expect(code.tagName).toBe("PRE")
    expect(code.className.split(" ")).toEqual(
      expect.arrayContaining(["whitespace-pre", "overflow-x-auto"])
    )
    expect(view.getByText("Fill it in a migration:").tagName).toBe("SPAN")
  })

  // The banner of a branch's app links here: the page asks, rather than refreshing on a link.
  test("asks before a refresh, saying what is lost, and refreshes once confirmed", async () => {
    const seen = answerWith((request) =>
      request.method === "POST"
        ? Response.json(branch({ refreshRequestedAt: ago(0) }), { status: 202 })
        : Response.json({ branches: [branch()], unavailable: null, now: NOW })
    )
    const { view } = renderPage(
      { branches: [branch()], unavailable: null, now: NOW },
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

  // A refresh copies what the branch's creator sees, whoever asks: Ada refreshing Sam's branch
  // gets Sam's view, not hers. Red check: show `refresh.description` whoever started the branch.
  test("says a refresh copies what the branch's creator sees", async () => {
    answerWith((request) =>
      request.url.includes("usr_sam")
        ? Response.json({
            id: "usr_sam",
            email: "sam@northline.test",
            displayName: "Sam Ortiz",
            status: "active",
          })
        : Response.json({ branches: [], unavailable: null, now: NOW })
    )
    const { view } = renderPage(
      { branches: [branch({ createdBy: "usr_sam" })], unavailable: null, now: NOW },
      "/console/branches?branch=feature%2Froute-planner&refresh=1"
    )

    const dialog = await view.findByRole("alertdialog")
    expect(
      await within(dialog).findByText(
        "It takes a new copy of what Sam Ortiz sees in production now. Changes made on this branch are discarded."
      )
    ).toBeDefined()
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
      const { view } = renderPage({ branches: [branch()], unavailable: null, now: NOW })
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
    expect(within(bar).getByTitle("Production data from 2 hours ago").textContent).toBe(
      "Data 2 h ago"
    )
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

  // Folded, a wide screen's tab sits at the end of the document: over the agent's and artifacts'
  // full-screen pages, which painted over it when it came before them. A phone's strip stays in
  // the page's flow, which starts below it rather than under it. Red check: return the tab in
  // place rather than through `createPortal` (`branch-banner.tsx`), or portal the strip too.
  test("folded, stays above every page, full-screen ones included", () => {
    const view = renderBanner({
      id: "northline",
      locale: "en",
      timeZone: "UTC",
      branch: { name: "feature/route-planner", dataTakenAt: null, productionUrl: null },
    })
    fireEvent.click(view.getByRole("button", { name: "Hide the branch bar" }))

    const [strip, tab] = view.getAllByRole("button", {
      name: "Show the bar of branch feature/route-planner",
    })
    expect(view.container.contains(strip ?? null)).toBe(true)
    expect(view.container.contains(tab ?? null)).toBe(false)
    expect(tab?.parentElement?.parentElement === view.baseElement).toBe(true)

    fireEvent.click(tab!)
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
    const [show] = again.getAllByRole("button", {
      name: "Show the bar of branch feature/route-planner",
    })
    fireEvent.click(show!)
    expect(again.getByRole("complementary")).toBeDefined()
  })
})

function rowOf(view: ReturnType<typeof render>, name: string): HTMLElement {
  const label = view.getByText(name)
  const row = label.closest<HTMLElement>("[data-branch]")
  if (!row) throw new Error(`No row for ${name}`)
  return row
}
