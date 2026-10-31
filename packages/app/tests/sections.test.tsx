import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { GetAuthSessionResponse } from "@sixb/client"
import {
  getAuthAccessManagementOptionsQueryKey,
  getAuthInvitationOptionsQueryKey,
  getAuthMembershipOptionsQueryKey,
  getAuthSessionQueryKey,
  listActionsOptions,
  listAuthInvitationsQueryKey,
  listAuthMembersQueryKey,
  listAuthServiceAccountsQueryKey,
  listAuthSessionsQueryKey,
  listObjectTypesOptions,
  listRulesOptions,
  listSyncsQueryKey,
  listWorkflowsOptions,
  objectCountOptions,
} from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render } from "@testing-library/react"
import type { ReactNode } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { type AppSectionId, AppShell, useSections } from "../src"
import {
  ConsoleSyncPage,
  ConsoleSyncsPage,
  SectionsProvider,
  SettingsMembersPage,
  SettingsPersonalPage,
} from "../src/pages"
import { resolveOpenSections } from "../src/sections/sections"
import { installDom } from "./helpers/dom"
import { stubWebSockets } from "./helpers/offline-sockets"

const browser = installDom([
  "localStorage",
  "sessionStorage",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLFormElement",
  "HTMLSelectElement",
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
])
let sockets: ReturnType<typeof stubWebSockets> | undefined

beforeAll(() => {
  sockets = stubWebSockets()
})

afterEach(() => {
  browser.localStorage.clear()
})

afterAll(() => {
  sockets?.restore()
})

const allSettingsPages = ["personal", "developers", "memory", "members", "usage", "activity"]
const manager = {
  console: true,
  logs: true,
  members: true,
  serviceAccounts: true,
  usage: true,
  activity: true,
}
const nobody = {
  console: false,
  logs: false,
  members: false,
  serviceAccounts: false,
  usage: false,
  activity: false,
}
const dataPages = ["connectors", "syncs", "datasets", "pipelines", "projections"]
const allConsolePages = [
  ...dataPages,
  "object-types",
  "objects",
  "graph",
  "actions",
  "workflows",
  "rules",
  "logs",
]

function sessionFor(
  groupIds: readonly string[],
  access: typeof manager = manager
): GetAuthSessionResponse {
  return {
    authenticated: true,
    user: {
      id: "user-1",
      email: "morgan@example.com",
      displayName: "Morgan Reyes",
      groupIds: [...groupIds],
    },
    access,
    session: { id: "session-1", expiresAt: "2026-10-15T00:00:00.000Z" },
  }
}

function renderApp(
  ui: ReactNode,
  options: {
    readonly path: string
    readonly session?: GetAuthSessionResponse | null
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
      <SectionsProvider>
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

  const yours = ["personal", "developers", "memory"]
  const cases: {
    readonly name: string
    readonly section: AppSectionId
    readonly signedIn: boolean
    readonly access?: typeof manager
    readonly pages: readonly string[]
  }[] = [
    // Settings opens to everyone signed in; a project page to whoever may do what it is for.
    {
      name: "Settings, may manage nothing",
      section: "settings",
      signedIn: true,
      access: nobody,
      pages: yours,
    },
    {
      name: "Settings, may manage members",
      section: "settings",
      signedIn: true,
      access: { ...nobody, members: true },
      pages: [...yours, "members"],
    },
    {
      name: "Settings, may manage service accounts",
      section: "settings",
      signedIn: true,
      access: { ...nobody, serviceAccounts: true },
      // Members holds Service accounts as a tab.
      pages: [...yours, "members"],
    },
    {
      name: "Settings, may observe AI usage",
      section: "settings",
      signedIn: true,
      access: { ...nobody, usage: true },
      pages: [...yours, "usage"],
    },
    {
      name: "Settings, may observe activity",
      section: "settings",
      signedIn: true,
      access: { ...nobody, activity: true },
      pages: [...yours, "activity"],
    },
    {
      name: "Settings, may do everything",
      section: "settings",
      signedIn: true,
      access: manager,
      pages: allSettingsPages,
    },
    // Settings needs a signed-in person.
    {
      name: "Settings, signed out",
      section: "settings",
      signedIn: false,
      pages: [],
    },
    // The Console is open without auth; signed in, it takes can.observe(project.console).
    {
      name: "Console, auth off",
      section: "console",
      signedIn: false,
      pages: allConsolePages,
    },
    {
      name: "Console, signed in without the grant",
      section: "console",
      signedIn: true,
      access: nobody,
      pages: [],
    },
    // Logs, like Usage and Activity, opens to whoever may read them.
    {
      name: "Console, signed in with the grant",
      section: "console",
      signedIn: true,
      access: { ...nobody, console: true },
      pages: allConsolePages.filter((page) => page !== "logs"),
    },
    {
      name: "Console, signed in with the grant and logs",
      section: "console",
      signedIn: true,
      access: { ...nobody, console: true, logs: true },
      pages: allConsolePages,
    },
  ]

  test.each(cases)("$name", ({ section, signedIn, access = null, pages }) => {
    expect(pagesOf({ signedIn, access, enabled: true }, section)).toEqual([...pages])
  })

  test("shared links get no sections", () => {
    expect(
      resolveOpenSections({
        signedIn: true,
        access: manager,
        enabled: false,
      })
    ).toEqual([])
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
    expect(hrefsIn("Your account")).toEqual([
      "/settings/personal",
      "/settings/developers",
      "/settings/memory",
    ])
    expect(hrefsIn("Project")).toEqual([
      "/settings/members",
      "/settings/usage",
      "/settings/activity",
    ])
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
  // sections and the sidebar links to the Console; drop `signedOut` from UserMenu and the button reads
  // Preferences.
  test("the sections open from the user menu, and the sidebar holds the app's own nav", () => {
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
    expect(view.getByText("Console /console/connectors, Settings /settings/personal")).toBeDefined()
    expect(view.getByRole("button", { name: /Morgan Reyes/ })).toBeDefined()
    cleanup()

    // With auth off nobody signs in: the button says so, Settings is gone, the rest stay.
    const signedOut = renderApp(shell, { path: "/quotes", session: null })
    expect(sidebarLinks(signedOut.container)).toEqual(["/quotes"])
    expect(signedOut.getByText("Console /console/connectors")).toBeDefined()
    expect(signedOut.getByRole("button", { name: "Sign-in off" })).toBeDefined()
  })

  test("inside the Console the sidebar lists its pages, Data's under one heading", () => {
    const view = renderApp(
      <AppShell nav={[{ label: "Quotes", href: "/quotes" }]}>
        <ConsoleSyncsPage />
      </AppShell>,
      { path: "/console/syncs", data: [[listSyncsQueryKey(), []]] }
    )
    expect(view.getByRole("heading", { name: "Syncs" })).toBeDefined()
    const nav = view.getByText("Connectors").closest('[data-slot="sidebar-group"]')
    expect(nav?.querySelector('[data-slot="sidebar-group-label"]')?.textContent).toBe("Data")
    expect(
      [...(nav?.querySelectorAll("a") ?? [])].map((link) => link.getAttribute("href"))
    ).toEqual(dataPages.map((page) => `/console/${page}`))
    expect(view.queryByText("Quotes")).toBeNull()
    expect(view.getByText("No syncs")).toBeDefined()
  })
  // An object's page sits outside every section so grants alone decide who reads it, yet it opens
  // from Objects. Regression proof: drop `activeFor` from the Objects page in the catalog and the
  // sidebar falls back to the app's nav.
  test("an object's page keeps the Console sidebar, with Objects current", () => {
    const counts = [
      [listObjectTypesOptions().queryKey, []],
      [objectCountOptions().queryKey, 15],
      [listActionsOptions().queryKey, []],
      [listWorkflowsOptions().queryKey, []],
      [listRulesOptions().queryKey, []],
    ] as const
    const objectPage = (session?: GetAuthSessionResponse) =>
      renderApp(
        <AppShell nav={[{ label: "Quotes", href: "/quotes" }]}>
          <p>Object page</p>
        </AppShell>,
        { path: "/objects/Account/A-1005", session, data: counts }
      )

    const view = objectPage()
    expect(view.queryByText("Quotes")).toBeNull()
    expect(view.getByText("Console")).toBeDefined()
    const objects = view.getByRole("link", { name: /Objects/ })
    expect(objects.getAttribute("href")).toBe("/console/objects")
    expect(objects.getAttribute("data-active")).toBe("true")
    cleanup()

    // Without the section the page still opens, in the app's own sidebar.
    const hidden = objectPage(sessionFor([], nobody))
    expect(hidden.getByText("Quotes")).toBeDefined()
    expect(hidden.queryByText("Console")).toBeNull()
    expect(hidden.getByText("Object page")).toBeDefined()
  })
})

describe("who may open a section page", () => {
  // Regression proof: delete the `closed` redirect in SectionPage and this renders the members page.
  test("a project page someone may not use sends its URL home", () => {
    const view = renderApp(<SettingsMembersPage />, {
      path: "/settings/members",
      session: sessionFor(["staff"], nobody),
    })
    expect(view.getByText("Home page")).toBeDefined()
  })

  test("a Console page sends someone without the grant home, detail pages included", () => {
    for (const [page, path] of [
      [<ConsoleSyncsPage key="list" />, "/console/syncs"],
      [<ConsoleSyncPage key="detail" />, "/console/syncs/sync-orbit"],
    ] as const) {
      const view = renderApp(page, {
        path,
        session: sessionFor(["staff"], { ...manager, console: false }),
      })
      expect(view.getByText("Home page")).toBeDefined()
      cleanup()
    }
  })

  test("a page about yourself stays open to someone who may manage nothing", () => {
    const view = renderApp(<SettingsPersonalPage />, {
      path: "/settings/personal",
      session: sessionFor(["staff"], nobody),
      data: personalData,
    })
    expect(view.getByRole("heading", { name: "Personal" })).toBeDefined()
    expect(view.getByText("Morgan Reyes", { selector: "p" })).toBeDefined()
  })
})

describe("members", () => {
  const ava = {
    user: {
      id: "usr_ava",
      email: "ava@example.com",
      displayName: "Ava Stone",
      status: "active" as const,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
    groupIds: ["admins"],
    managedGroupIds: [],
    capabilities: { assignGroups: true, suspend: true, reactivate: false },
    // Just now, for "Active now".
    lastActiveAt: new Date().toISOString(),
  }
  // Ben never signed in.
  const ben = {
    user: { ...ava.user, id: "usr_ben", email: "ben@example.com", displayName: "Ben Ortiz" },
    groupIds: ["staff"],
    managedGroupIds: [],
    capabilities: ava.capabilities,
  }
  const groups = [
    { id: "admins", label: "Admins", description: "Run the project" },
    { id: "staff", label: "Staff" },
  ]
  const data = (serviceAccounts = true) =>
    [
      [
        getAuthMembershipOptionsQueryKey(),
        {
          groups,
          serviceAccountGroups: serviceAccounts ? [groups[0]] : [],
          capabilities: { invite: true, assignGroups: true, suspend: true, serviceAccounts },
        },
      ],
      [
        listAuthMembersQueryKey({ query: { order: "asc", limit: "100" } }),
        { members: [ava, ben], hasMore: false, total: 2 },
      ],
      [
        listAuthInvitationsQueryKey({ query: { order: "desc", limit: "100" } }),
        {
          invitations: [
            {
              id: "inv_1",
              email: "cleo@example.com",
              groupIds: ["staff"],
              status: "pending",
              createdAt: "2026-10-29T00:00:00.000Z",
              updatedAt: "2026-10-29T00:00:00.000Z",
              expiresAt: "2099-11-05T00:00:00.000Z",
            },
          ],
          hasMore: false,
          total: 1,
        },
      ],
      [
        getAuthInvitationOptionsQueryKey(),
        {
          groups,
          canInviteWithoutGroups: false,
          capabilities: { createInvitation: { state: "enabled" } },
        },
      ],
      [listAuthServiceAccountsQueryKey(), { serviceAccounts: [] }],
    ] as const
  // The people listed, in order: each row shows its email.
  const rowText = (view: ReturnType<typeof renderApp>) => [
    ...new Set(view.container.textContent?.match(/(?:ava|ben|cleo)@example\.com/g) ?? []),
  ]

  // Removal proof: list the invitations before the members and Cleo comes first.
  test("People lists members, then who is invited, and a group narrows both", () => {
    const view = renderApp(<SettingsMembersPage />, { path: "/settings/members", data: data() })
    expect(rowText(view)).toEqual(["ava@example.com", "ben@example.com", "cleo@example.com"])
    expect(view.getByText("Active now")).toBeDefined()
    expect(view.getByText("Not signed in yet")).toBeDefined()
    expect(view.getAllByRole("button", { name: "Copy new link" }).length).toBeGreaterThan(0)
    cleanup()

    const staffOnly = renderApp(<SettingsMembersPage />, {
      path: "/settings/members?tab=people&group=staff",
      data: data(),
    })
    const shown = rowText(staffOnly).join(" ")
    expect(shown).toContain("cleo@example.com")
    expect(shown).toContain("ben@example.com")
    expect(shown).not.toContain("ava@example.com")
  })

  // Regression proof: drop the `onOpen` from GroupRow and the click leaves Groups in place.
  test("Groups shows who is in each, and opens its people", () => {
    const view = renderApp(<SettingsMembersPage />, {
      path: "/settings/members?tab=groups",
      data: data(),
    })
    const adminsRow = view.getByText("Admins", { selector: "span" }).closest("button")
    expect(adminsRow?.textContent).toContain("1 person")
    const staffRow = view.getByText("Staff", { selector: "span" }).closest("button")
    expect(staffRow?.textContent).toContain("1 invited")

    fireEvent.click(adminsRow as HTMLElement)
    expect(rowText(view).join(" ")).toContain("ava@example.com")
    expect(rowText(view).join(" ")).not.toContain("ben@example.com")
  })

  test("Service accounts is a tab for whoever may manage them", () => {
    const denied = renderApp(<SettingsMembersPage />, {
      path: "/settings/members?tab=service-accounts",
      session: sessionFor([], { ...manager, serviceAccounts: false }),
      data: data(false),
    })
    expect(denied.queryByRole("tab", { name: /Service accounts/ })).toBeNull()
    // The address names a tab they may not use, so People opens instead.
    expect(denied.getByRole("button", { name: "Invite people" })).toBeDefined()
    cleanup()

    const allowed = renderApp(<SettingsMembersPage />, {
      path: "/settings/members?tab=service-accounts",
      data: data(),
    })
    expect(allowed.getByRole("tab", { name: /Service accounts/ })).toBeDefined()
    expect(allowed.getAllByRole("button", { name: "New service account" }).length).toBeGreaterThan(
      0
    )
    expect(allowed.getByText("No service accounts yet")).toBeDefined()
  })
})
