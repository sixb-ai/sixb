import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { GetAuthSessionResponse } from "@sixb/client"
import {
  getAuthAccessManagementOptionsQueryKey,
  getAuthMembershipOptionsQueryKey,
  getAuthSessionQueryKey,
  listAuthServiceAccountsQueryKey,
  listAuthSessionsQueryKey,
} from "@sixb/client/hooks"
import { defineGroup } from "@sixb/core/security"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render } from "@testing-library/react"
import { Window } from "happy-dom"
import type { ReactNode } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { AppShell, type AppVisibility, useSections } from "../src"
import {
  SectionsProvider,
  SettingsMembersPage,
  SettingsPersonalPage,
  SettingsServiceAccountsPage,
} from "../src/pages"
import { resolveOpenSections } from "../src/sections/sections"

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

beforeAll(() => {
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
  for (const key of globals) {
    const descriptor = previous.get(key)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  browser.close()
})

const admins = defineGroup("admins", { label: "Admins" })
const allSettingsPages = ["personal", "developers", "members", "service-accounts"]

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

const personalData = [
  [
    getAuthAccessManagementOptionsQueryKey(),
    { groups: [{ id: "admins", label: "Admins" }] },
  ] as const,
  [listAuthSessionsQueryKey(), { sessions: [] }] as const,
] as const

describe("who sees each section", () => {
  const pagesOf = (input: Parameters<typeof resolveOpenSections>[0]) =>
    resolveOpenSections(input).flatMap((section) => section.pages.map((page) => page.id))

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

  // UserMenu lists what useSections returns; happy-dom cannot open its dropdown, so this reads the
  // same hook. Regression proof: add a Settings link to AppShell's SectionNav fallback and the
  // sidebar expectation fails.
  test("Settings is reached from the user menu, not the sidebar", () => {
    function SectionLinks() {
      return (
        <p>
          {useSections()
            .map((section) => `${section.label} ${section.href}`)
            .join(",")}
        </p>
      )
    }

    const view = renderApp(
      <AppShell nav={[{ label: "Quotes", href: "/quotes" }]}>
        <SectionLinks />
      </AppShell>,
      { path: "/quotes" }
    )
    expect(view.getByText("Quotes").closest("a")).not.toBeNull()
    expect(view.queryByRole("link", { name: /Settings/ })).toBeNull()
    expect(view.getByText("Settings /settings/personal")).toBeDefined()
    cleanup()

    const signedOut = renderApp(<SectionLinks />, { path: "/quotes", session: null })
    expect(signedOut.container.textContent).toBe("")
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
