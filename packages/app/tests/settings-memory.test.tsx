import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { client, type GetAuthSessionResponse } from "@sixb/client"
import {
  getAgentMemoryQueryKey,
  getAuthSessionQueryKey,
  listAgentMemoryRevisionsQueryKey,
} from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { SectionsProvider, SettingsMemoryPage } from "../src/pages"
import { TextEditor } from "../src/pages/settings/memory"
import { installDom } from "./helpers/dom"
import { stubWebSockets } from "./helpers/offline-sockets"

installDom([
  "localStorage",
  "sessionStorage",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
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
const baseUrl = client.getConfig().baseUrl

beforeAll(() => {
  sockets = stubWebSockets()
  // The page's requests need an origin to resolve against.
  client.setConfig({ baseUrl: "https://app.sixb.test" })
})

afterAll(() => {
  sockets?.restore()
  client.setConfig({ baseUrl })
})

const session: GetAuthSessionResponse = {
  authenticated: true,
  user: { id: "usr_priya", email: "priya@example.com", groupIds: [] },
  session: { id: "session-1", expiresAt: "2099-10-15T00:00:00.000Z" },
}

const thisYear = new Date().getFullYear()
const mine = {
  repo: "user" as const,
  revision: 2,
  files: [
    {
      path: "MEMORY.md",
      contents: `# Memory\n\n- Prefers short bullet lists (added 2025-10-04)\n- Billing: [[projects/payments]] (added ${thisYear}-03-02)\n- Old notes: [[archive]]\n`,
    },
    { path: "projects/payments.md", contents: "- Invoices exclude VAT (added 2026-10-12)\n" },
  ],
}

const history = {
  revisions: [
    {
      revision: 2,
      message: "Invoices exclude VAT",
      author: { type: "user" as const, id: "usr_priya" },
      source: "/agents/thr_8f2",
      changes: [
        { path: "MEMORY.md", deleted: false },
        { path: "projects/payments.md", deleted: false },
      ],
      createdAt: "2026-10-12T09:00:00.000Z",
    },
    {
      revision: 1,
      message: "Prefers short bullet lists",
      author: { type: "user" as const, id: "usr_priya" },
      changes: [{ path: "MEMORY.md", deleted: false }],
      createdAt: "2026-10-04T09:00:00.000Z",
    },
  ],
  hasMore: false,
  total: 2,
}

function renderPage(
  path: string,
  data: readonly (readonly [readonly unknown[], unknown])[] = [
    [getAgentMemoryQueryKey({ path: { repo: "user" } }), mine],
    [listAgentMemoryRevisionsQueryKey({ path: { repo: "user" }, query: { limit: "20" } }), history],
  ]
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  })
  queryClient.setQueryData(getAuthSessionQueryKey(), session)
  for (const [key, value] of data) queryClient.setQueryData(key, value)
  return render(
    <QueryClientProvider client={queryClient}>
      <SectionsProvider visibility={undefined}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="*" element={<SettingsMemoryPage />} />
          </Routes>
        </MemoryRouter>
      </SectionsProvider>
    </QueryClientProvider>
  )
}

/** Answers each request with `response`, recording each one. */
async function withApi<T>(
  response: (request: Request) => Response,
  run: (requests: Request[]) => Promise<T>
): Promise<T> {
  const fetch = globalThis.fetch
  const requests: Request[] = []
  globalThis.fetch = (async (input: Request) => {
    requests.push(input.clone())
    return response(input)
  }) as typeof globalThis.fetch
  try {
    return await run(requests)
  } finally {
    globalThis.fetch = fetch
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("the Memory page", () => {
  test("opens on the main memory, read as a document beside the files", () => {
    const view = renderPage("/settings/memory")

    expect(view.getByRole("tab", { name: /Memories/ }).textContent).toBe("Memories4")
    const files = view.getByRole("navigation", { name: "Memory files" })
    expect([...files.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "Main memory",
      "projects",
      "payments",
    ])
    expect(files.querySelector("[aria-current=page]")?.textContent).toBe("Main memory")
    // An entry reads apart from its date, which is in the reader's locale, its year only when past.
    const old = view.getByTitle("2025-10-04")
    expect(old.textContent).toBe("added Oct 4, 2025")
    expect(old.closest("li")?.textContent).toStartWith("Prefers short bullet lists")
    expect(view.getByTitle(`${thisYear}-03-02`).textContent).toBe("added Mar 2")
    // A link to a file opens it here; one to a file that is gone is its plain name.
    const document = view.getByRole("article")
    expect(
      [...document.querySelectorAll("a")]
        .find((link) => link.textContent === "payments")
        ?.getAttribute("href")
    ).toBe("/settings/memory?file=projects%2Fpayments.md")
    expect(view.getByText(/Old notes: archive/)).toBeDefined()
  })

  test("opens a file from its address, named by its path", () => {
    const view = renderPage("/settings/memory?file=projects%2Fpayments.md")

    expect(view.getByRole("heading", { level: 2 }).textContent).toBe("projects/payments")
    expect(view.getByTitle("2026-10-12").closest("li")?.textContent).toStartWith(
      "Invoices exclude VAT"
    )
  })

  test("searches every file, keeping those that mention it, with how often", () => {
    const view = renderPage("/settings/memory")
    const search = view.getByRole("textbox", { name: "Search memories" })
    search.focus()
    // React DOM loads before this window, so it reads typing in a focused field from key events.
    fireEvent.input(search, { target: { value: "vat" } })
    fireEvent.keyUp(search, { key: "t" })

    const files = view.getByRole("navigation", { name: "Memory files" })
    expect([...files.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "projects",
      "payments1",
    ])
  })

  test("adds a memory where the agent would, as a save from the revision on the page", async () => {
    await withApi(
      (request) =>
        request.method === "POST"
          ? json(201, { repo: "user", revision: 3, warnings: [] })
          : request.url.includes("/revisions")
            ? json(200, history)
            : json(200, { ...mine, revision: 3 }),
      async (requests) => {
        const view = renderPage("/settings/memory")
        fireEvent.click(view.getByRole("button", { name: "Add memory" }))
        const field = view.getByRole("textbox", {
          name: "Something the agent should remember about you",
        })
        field.focus()
        fireEvent.input(field, { target: { value: "Prefers euros" } })
        fireEvent.keyUp(field, { key: "s" })
        fireEvent.submit(field.closest("form") as HTMLFormElement)

        await waitFor(() =>
          expect(requests.some((request) => request.method === "POST")).toBe(true)
        )
        const save = requests.find((request) => request.method === "POST")
        expect(new URL(save?.url ?? "").pathname).toBe("/api/agent-memory/user/revisions")
        const body = (await save?.json()) as {
          baseRevision: number
          message: string
          changes: { path: string; contents: string }[]
        }
        expect(body.baseRevision).toBe(2)
        expect(body.message).toBe("Prefers euros")
        expect(body.changes[0]?.contents).toMatch(
          /\[\[archive\]\]\n- Prefers euros \(added \d{4}-\d{2}-\d{2}\)\n$/
        )
      }
    )
  })

  test("shows history by day, linking only the person's own conversations", () => {
    // Reproduce by giving useChangeOrigin a teammate's source as its conversation: it links too.
    const teammate = {
      revision: 3,
      message: "A dossier is a Case",
      author: { type: "user" as const, id: "usr_adam" },
      source: "/agents/thr_a41",
      changes: [{ path: "MEMORY.md", deleted: false }],
      createdAt: "2026-10-20T09:00:00.000Z",
    }
    const view = renderPage("/settings/memory?repo=project&view=history", [
      [getAgentMemoryQueryKey({ path: { repo: "project" } }), { ...mine, repo: "project" }],
      [
        listAgentMemoryRevisionsQueryKey({ path: { repo: "project" }, query: { limit: "20" } }),
        { ...history, revisions: [teammate, ...history.revisions], total: 3 },
      ],
    ])

    expect(view.getByText("Saved in a teammate's conversation")).toBeDefined()
    expect(view.getByText("Saved in your conversation")).toBeDefined()
    expect(view.getByText("Edited by you")).toBeDefined()
    expect(view.getByText("Main memory, projects/payments")).toBeDefined()
    expect(
      view
        .getAllByRole("link", { name: "Open the conversation" })
        .map((link) => link.getAttribute("href"))
    ).toEqual(["/agents/thr_8f2"])
  })

  test("says what will be remembered when nothing is yet", () => {
    const view = renderPage("/settings/memory", [
      [
        getAgentMemoryQueryKey({ path: { repo: "user" } }),
        { repo: "user", revision: 0, files: [] },
      ],
    ])

    expect(view.getByText("Nothing remembered yet")).toBeDefined()
    expect(view.getByRole("button", { name: "Add memory" })).toBeDefined()
    // Nothing to delete, so no menu to delete it from.
    expect(view.queryByRole("button", { name: "More" })).toBeNull()
  })

  test("says who the project's memory is open to when the API refuses it", async () => {
    await withApi(
      () => json(403, { error: "[Sixb] The project's Agent memory needs …", code: "not_allowed" }),
      async () => {
        const view = renderPage("/settings/memory?repo=project", [])
        await waitFor(() =>
          expect(
            view.getByText("The project's memory is open to people who can use the agent.")
          ).toBeDefined()
        )
      }
    )
  })
})

describe("Edit as text", () => {
  test("keeps a draft the file changed under, and saves it only from the latest version", () => {
    // Reproduce by having TextEditor's submit save from the `revision` prop, with no `stale` check:
    // the Save after a 409 goes out from revision 3 and replaces the line saved there meanwhile.
    const opened = mine.files[0]?.contents ?? ""
    const saves: number[] = []
    const editor = (contents: string, revision: number) => (
      <TextEditor
        name="Main memory"
        contents={contents}
        revision={revision}
        pending={false}
        onSave={(_draft, _note, baseRevision) => {
          saves.push(baseRevision)
        }}
        onCancel={() => {}}
      />
    )
    const view = render(editor(opened, 2))
    const field = view.getByRole("textbox", { name: "Editing Main memory" })
    const type = (value: string) => {
      fireEvent.input(field, { target: { value } })
      fireEvent.keyUp(field, { key: "s" })
    }
    const submit = () => fireEvent.submit(field.closest("form") as HTMLFormElement)

    type("# Memory\n\n- Prefers tables\n")
    submit()
    expect(saves).toEqual([2])

    // The save was refused and the page reloaded the file another conversation saved.
    view.rerender(editor(`${opened}- Prefers euros (added 2026-10-20)\n`, 3))
    view.getByText("Main memory changed since you opened it.")
    expect((field as HTMLTextAreaElement).value).toBe("# Memory\n\n- Prefers tables\n")
    submit()
    expect(saves).toEqual([2])

    fireEvent.click(view.getByRole("button", { name: "Start from the latest version" }))
    expect((field as HTMLTextAreaElement).value).toContain("- Prefers euros")
    type("# Memory\n\n- Prefers euros, in tables\n")
    submit()
    expect(saves).toEqual([2, 3])
  })
})
