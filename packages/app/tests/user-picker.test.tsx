import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { client } from "@sixb/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { UserPicker, useMemberSearch } from "../src/pages/ontology/components/user-picker"
import { installDom } from "./helpers/dom"

installDom([
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Event",
  "EventTarget",
  "MutationObserver",
  "getComputedStyle",
])

const originalConfig = client.getConfig()
client.setConfig({ baseUrl: "https://api.sixb.test" })

afterEach(() => {
  client.setConfig({ fetch: originalConfig.fetch })
})

afterAll(() => {
  client.setConfig({ baseUrl: originalConfig.baseUrl })
})

const ava = {
  id: "usr_ava",
  email: "ava@acme.com",
  displayName: "Ava Martin",
  status: "active" as const,
}
const cleo = { id: "usr_cleo", email: "cleo@acme.com", status: "suspended" as const }

function serveDirectory(respond: (path: string) => Response): string[] {
  const requests: string[] = []
  client.setConfig({
    fetch: (async (request: Request) => {
      const url = new URL(request.url)
      requests.push(`${url.pathname}${url.search}`)
      return respond(url.pathname)
    }) as typeof fetch,
  })
  return requests
}

function withQueryClient({ children }: { readonly children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

function renderPicker(value: string) {
  return render(<UserPicker id="assignee" value={value} onChange={() => {}} />, {
    wrapper: withQueryClient,
  })
}

describe("the member picker", () => {
  test("labels the chosen member with their name", async () => {
    serveDirectory(() => Response.json({ users: [ava], hasMore: false, total: 1 }))

    const view = renderPicker("usr_ava")

    await waitFor(() => expect(view.getByRole("combobox").textContent).toBe("Ava Martin"))
  })

  test("looks up a chosen member the first page does not hold", async () => {
    const requests = serveDirectory((path) =>
      path === "/api/users/usr_cleo"
        ? Response.json(cleo)
        : Response.json({ users: [ava], hasMore: false, total: 1 })
    )

    const view = renderPicker("usr_cleo")

    await waitFor(() => expect(view.getByRole("combobox").textContent).toBe("cleo@acme.com"))
    expect(requests).toContain("/api/users/usr_cleo")
  })

  test("falls back to an id input without access to the directory", async () => {
    serveDirectory(() =>
      Response.json({ error: "[Sixb] Principal 'usr_1' is not allowed." }, { status: 403 })
    )

    const view = renderPicker("usr_ava")

    const input = await waitFor(() => view.getByPlaceholderText("User ID") as HTMLInputElement)
    expect(input.value).toBe("usr_ava")
    expect(view.queryByRole("combobox")).toBeNull()
  })
})

describe("searching the directory", () => {
  test("asks the server once typing pauses, keeping the last page meanwhile", async () => {
    const requests = serveDirectory(() => Response.json({ users: [ava], hasMore: false, total: 1 }))
    const search = renderHook(({ text }) => useMemberSearch(text), {
      wrapper: withQueryClient,
      initialProps: { text: "" },
    })
    await waitFor(() => expect(search.result.current.members).toEqual([ava]))

    for (const text of ["o", "ok", "okaf", " okafor "]) search.rerender({ text })
    expect(search.result.current.members).toEqual([ava])

    await waitFor(() => expect(requests).toContain("/api/users?search=okafor&limit=20"))
    expect(requests).toEqual(["/api/users?limit=20", "/api/users?search=okafor&limit=20"])
  })

  test("treats only a refusal as no access to the directory", async () => {
    // Removal proof: count any failure as denied and the picker drops to an id input on a 503.
    for (const [status, denied] of [
      [403, true],
      [503, false],
    ] as const) {
      serveDirectory(() => Response.json({ error: "[Sixb] Not now." }, { status }))
      const search = renderHook(() => useMemberSearch(""), { wrapper: withQueryClient })

      await waitFor(() => expect(search.result.current.failed).toBe(true))
      expect(search.result.current.denied).toBe(denied)
      search.unmount()
    }
  })
})
