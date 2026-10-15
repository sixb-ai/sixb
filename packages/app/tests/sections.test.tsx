import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { GetAuthSessionResponse } from "@sixb/client"
import {
  getAuthAccessManagementOptionsQueryKey,
  getAuthMembershipOptionsQueryKey,
  getAuthSessionQueryKey,
  listAuthServiceAccountsQueryKey,
  listAuthSessionsQueryKey,
  listSyncsQueryKey,
} from "@sixb/client/hooks"
import { defineGroup } from "@sixb/core/security"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render } from "@testing-library/react"
import { Window } from "happy-dom"
import type { ReactNode } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { type AppSectionId, AppShell, type AppVisibility, useSections } from "../src"
import {
  DataSyncPage,
  DataSyncsPage,
  SectionsProvider,
  SettingsMembersPage,
  SettingsPersonalPage,
  SettingsServiceAccountsPage,
} from "../src/pages"
import { resolveOpenSections } from "../src/sections/sections"
import { stubWebSockets } from "./helpers/offline-sockets"

const browser = new Window({ url: "https://app.sixb.test" })
const globals = [
  "localStorage",
  "sessionStorage",
  "window",
  "self",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "EventTarget",
  "MouseEvent",
  "KeyboardEvent",
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
] as const
const previous = new Map<string, PropertyDescriptor | undefined>()
let sockets: ReturnType<typeof stubWebSockets> | undefined

beforeAll(() => {
  sockets = stubWebSockets()
  const values = browser as unknown as Record<string, unknown>
  for (const key of globals) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value:
        key === "window" || key === "self"
          ? browser
          : key === "IS_REACT_ACT_ENVIRONMENT"
            ? true
            : values[key],
    })
  }
})

afterEach(() => {
  cleanup()
  browser.localStorage.clear()
})

afterAll(() => {
  sockets?.restore()
  for (const key of globals) {
    const descriptor = previous.get(key)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  browser.close()
})

const admins = defineGroup("admins", { label: "Admins" })
const allSettingsPages = ["personal", "developers", "members", "service-accounts"]
const allDataPages = ["connectors", "syncs", "datasets", "pipelines", "projections"]

function sessionFor(groupIds: readonly string[]): GetAuthSessionResponse {
  return {
    authenticated: true,
    applicationAccess: { allowed: true, audience: "app" },
    user: {
      id: "user-1",
      email: "morgan@example.com",
      displayName: "Morgan Reyes",
      groupIds: [...groupIds],
    },
    session: { id: "session-1", expiresAt: "2026-10-15T00:00:00.000Z" },
  }
}

function renderApp(
  ui: ReactNode,
  options: {
    readonly path: string
    readonly session?: GetAuthSessionResponse | null
    readonly visibility?: AppVisibility
    readonly data?: readonly (readonly [readonly unknown[], unknown])[]
  }
) {
  // Cached answers never go stale, so no page tries to reach an API.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  })
  queryClient.setQueryData(
    getAuthSessionQueryKey(),
    options.session === null
      ? { authenticated: false, authEnabled: false }
      : (options.session ?? sessionFor([]))
  )
  for (const [key, value] of options.data ?? []) queryClient.setQueryData(key, value)
  return render(
    <QueryClientProvider client={queryClient}>
      <SectionsProvider visibility={options.visibility}>
        <MemoryRouter initialEntries={[options.path]}>
          <Routes>
            <Route path="/" element={<p>Home page</p>} />
            <Route path="*" element={ui} />
          </Routes>
        </MemoryRouter>
      </SectionsProvider>
    </QueryClientProvider>
  )
}

function sidebarLinks(container: HTMLElement) {
  return [...container.querySelectorAll('[data-sidebar="content"] a')].map((link) =>
    link.getAttribute("href")
  )
}

const personalData = [
  [
    getAuthAccessManagementOptionsQueryKey(),
    { groups: [{ id: "admins", label: "Admins" }] },
  ] as const,
  [listAuthSessionsQueryKey(), { sessions: [] }] as const,
] as const

describe("who sees each section", () => {
  const pagesOf = (
    input: Parameters<typeof resolveOpenSections>[0],
    section: AppSectionId = "settings"
  ) =>
    resolveOpenSections(input)
      .filter((open) => open.definition.id === section)
      .flatMap((open) => open.pages.map((page) => page.id))

  test("a signed-in person sees every Settings page unless visibility narrows it", () => {
    expect(pagesOf({ user: { groupIds: [] }, visibility: undefined, enabled: true })).toEqual(
      allSettingsPages
    )
    expect(
      pagesOf({ user: { groupIds: ["admins"] }, visibility: { settings: [admins] }, enabled: true })
    ).toEqual(allSettingsPages)
  })

  test("outside the listed groups only the pages about yourself stay", () => {
    const yours = ["personal", "developers"]
    expect(
      pagesOf({ user: { groupIds: ["staff"] }, visibility: { settings: [admins] }, enabled: true })
    ).toEqual(yours)
    expect(
      pagesOf({ user: { groupIds: ["admins"] }, visibility: { settings: [] }, enabled: true })
    ).toEqual(yours)
  })

  test("Settings needs a signed-in person, and shared links get no sections", () => {
    expect(pagesOf({ user: null, visibility: undefined, enabled: true })).toEqual([])
    expect(pagesOf({ user: { groupIds: [] }, visibility: undefined, enabled: false })).toEqual([])
    expect(
      resolveOpenSections({ user: { groupIds: [] }, visibility: undefined, enabled: false })
    ).toEqual([])
  })

  test("Data is open without auth, and visibility narrows it to the listed groups", () => {
    expect(pagesOf({ user: null, visibility: undefined, enabled: true }, "data")).toEqual(
      allDataPages
    )
    expect(
      pagesOf({ user: { groupIds: ["staff"] }, visibility: undefined, enabled: true }, "data")
    ).toEqual(allDataPages)
    expect(
      pagesOf(
        { user: { groupIds: ["staff"] }, visibility: { data: [admins] }, enabled: true },
        "data"
      )
    ).toEqual([])
    expect(
      pagesOf(
        { user: { groupIds: ["admins"] }, visibility: { data: [admins] }, enabled: true },
        "data"
      )
    ).toEqual(allDataPages)
  })
})

describe("appearance", () => {
  // Regression proof: drop the `themed` check in personal.tsx and the second test finds the
  // heading; drop ThemePicker's onClick and the first never stores "dark".
  test("Personal picks the theme where the shell provides one", () => {
    const view = renderApp(
      <AppShell nav={[]}>
        <SettingsPersonalPage />
      </AppShell>,
      { path: "/settings/personal", data: personalData }
    )

    expect(view.getByRole("heading", { name: "Appearance" })).toBeDefined()
    const dark = view.getByRole("radio", { name: "Dark" })
    expect(dark.getAttribute("aria-checked")).toBe("false")
    fireEvent.click(dark)
    expect(dark.getAttribute("aria-checked")).toBe("true")
    expect(browser.localStorage.getItem("sixb-theme")).toBe("dark")
  })

  test("a shell without a theme leaves Appearance out", () => {
    const view = renderApp(<SettingsPersonalPage />, {
      path: "/settings/personal",
      data: personalData,
    })
    expect(view.getByRole("heading", { name: "Personal" })).toBeDefined()
    expect(view.queryByRole("heading", { name: "Appearance" })).toBeNull()
  })
})

describe("section navigation", () => {
  // Regression proof: make useSectionNavMounted return false and the first test fails.
  test("AppShell drills into Settings, and the page leaves out its own tabs", () => {
    const view = renderApp(
      <AppShell nav={[{ label: "Quotes", href: "/quotes" }]}>
        <SettingsPersonalPage />
      </AppShell>,
      { path: "/settings/personal", data: personalData }
    )

    expect(view.getByRole("heading", { name: "Personal" })).toBeDefined()
    // Your own pages and the project's pages sit in separate groups.
    const hrefsIn = (label: string) =>
      [
        ...(view.getByText(label).closest('[data-slot="sidebar-group"]')?.querySelectorAll("a") ??
          []),
      ].map((link) => link.getAttribute("href"))
    expect(hrefsIn("Your account")).toEqual(["/settings/personal", "/settings/developers"])
    expect(hrefsIn("Project")).toEqual(["/settings/members", "/settings/service-accounts"])
    // The sidebar holds the section's pages instead of the app's nav.
    expect(view.queryByText("Quotes")).toBeNull()
    expect(view.container.ownerDocument.querySelector('nav[aria-label="Settings"]')).toBeNull()
  })

  test("a shell without SectionNav gets the section's pages as tabs", () => {
    const view = renderApp(<SettingsPersonalPage />, {
      path: "/settings/personal",
      data: personalData,
    })

    const tabs = view.container.querySelector('nav[aria-label="Settings"]')
    expect(tabs).not.toBeNull()
    expect(
      [...(tabs?.querySelectorAll("a") ?? [])].map((link) => link.getAttribute("href"))
    ).toEqual(allSettingsPages.map((page) => `/settings/${page}`))
  })

  // UserMenu lists what useSections returns. happy-dom cannot open its dropdown (Radix picks a no-op
  // layout effect when it loads before the DOM globals exist, so the portal never mounts), so this
  // reads the same hook. Regression proof: give AppShell's SectionNav a fallback that lists the
  // sections and the sidebar links to Data; drop `signedOut` from UserMenu and the button reads
  // Preferences.
  test("Data and Settings open from the user menu, and the sidebar holds the app's own nav", () => {
    function MenuSections() {
      return (
        <p>
          {useSections()
            .map((section) => `${section.label} ${section.href}`)
            .join(", ")}
        </p>
      )
    }
    const shell = (
      <AppShell nav={[{ label: "Quotes", href: "/quotes" }]}>
        <MenuSections />
      </AppShell>
    )

    const view = renderApp(shell, { path: "/quotes" })
    expect(sidebarLinks(view.container)).toEqual(["/quotes"])
    expect(view.getByText("Data /data/connectors, Settings /settings/personal")).toBeDefined()
    expect(view.getByRole("button", { name: /Morgan Reyes/ })).toBeDefined()
    cleanup()

    // With auth off nobody signs in: the button says so, Settings is gone and Data stays.
    const signedOut = renderApp(shell, { path: "/quotes", session: null })
    expect(sidebarLinks(signedOut.container)).toEqual(["/quotes"])
    expect(signedOut.getByText("Data /data/connectors")).toBeDefined()
    expect(signedOut.getByRole("button", { name: "Sign-in off" })).toBeDefined()
  })

  test("inside Data the sidebar lists its pages, without group headings", () => {
    const view = renderApp(
      <AppShell nav={[{ label: "Quotes", href: "/quotes" }]}>
        <DataSyncsPage />
      </AppShell>,
      { path: "/data/syncs", data: [[listSyncsQueryKey(), []]] }
    )
    expect(view.getByRole("heading", { name: "Syncs" })).toBeDefined()
    const nav = view.getByText("Connectors").closest('[data-slot="sidebar-group"]')
    expect(
      [...(nav?.querySelectorAll("a") ?? [])].map((link) => link.getAttribute("href"))
    ).toEqual(allDataPages.map((page) => `/data/${page}`))
    expect(view.queryByText("Quotes")).toBeNull()
    expect(view.getByText("No syncs")).toBeDefined()
  })
})

describe("visibility on section pages", () => {
  // Regression proof: delete the `allowed` check in SectionPage and this renders the members page.
  test("a hidden page sends its URL home", () => {
    const view = renderApp(<SettingsMembersPage />, {
      path: "/settings/members",
      session: sessionFor(["staff"]),
      visibility: { settings: [admins] },
    })
    expect(view.getByText("Home page")).toBeDefined()
  })

  test("a Data page outside the listed groups sends its URL home, detail pages included", () => {
    for (const [page, path] of [
      [<DataSyncsPage key="list" />, "/data/syncs"],
      [<DataSyncPage key="detail" />, "/data/syncs/sync-orbit"],
    ] as const) {
      const view = renderApp(page, {
        path,
        session: sessionFor(["staff"]),
        visibility: { data: [admins] },
      })
      expect(view.getByText("Home page")).toBeDefined()
      cleanup()
    }
  })

  test("a page about yourself stays open outside the listed groups", () => {
    const view = renderApp(<SettingsPersonalPage />, {
      path: "/settings/personal",
      session: sessionFor(["staff"]),
      visibility: { settings: [admins] },
      data: personalData,
    })
    expect(view.getByRole("heading", { name: "Personal" })).toBeDefined()
    expect(view.getByText("Morgan Reyes", { selector: "p" })).toBeDefined()
  })
})

describe("service accounts", () => {
  const membershipOptions = (serviceAccounts: boolean) =>
    [
      getAuthMembershipOptionsQueryKey(),
      {
        groups: [],
        serviceAccountGroups: serviceAccounts ? [{ id: "admins", label: "Admins" }] : [],
        capabilities: { invite: false, assignGroups: false, suspend: false, serviceAccounts },
      },
    ] as const

  test("creating one is offered only under a serviceAccounts membership policy", () => {
    const empty = [listAuthServiceAccountsQueryKey(), { serviceAccounts: [] }] as const

    const denied = renderApp(<SettingsServiceAccountsPage />, {
      path: "/settings/service-accounts",
      data: [membershipOptions(false), empty],
    })
    expect(denied.getByText("Service accounts are managed by admins")).toBeDefined()
    expect(denied.queryByRole("button", { name: "New service account" })).toBeNull()
    cleanup()

    const allowed = renderApp(<SettingsServiceAccountsPage />, {
      path: "/settings/service-accounts",
      data: [membershipOptions(true), empty],
    })
    expect(allowed.getByRole("button", { name: "New service account" })).toBeDefined()
    expect(allowed.getByText("No service accounts yet")).toBeDefined()
  })
})
