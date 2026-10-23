import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { client, type GetArtifactVersionResponse } from "@sixb/client"
import { getAuthSessionQueryKey } from "@sixb/client/hooks"
import { FRAME_PROTOCOL } from "@sixb/core/artifacts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render } from "@testing-library/react"
import { ArtifactFrame } from "../src/artifacts/frame"
import { resetPageState } from "../src/artifacts/page-state"
import { installDom } from "./helpers/dom"

const browser = installDom([
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLIFrameElement",
  "Event",
  "MessageEvent",
  "EventTarget",
  "MutationObserver",
  "ResizeObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

const PAGE = "art_ra7ew4at1f"

function pageVersion(): GetArtifactVersionResponse {
  return {
    artifactId: PAGE,
    version: 1,
    title: "Lisbon rate what-if",
    entry: "index.html",
    files: [],
    outline: { kind: "page", title: "Lisbon rate what-if" },
    references: [],
    author: { type: "user", id: "user-1" },
    createdAt: "2026-10-19T12:00:00.000Z",
  }
}

/** What the page's calls asked of the API, and the values it keeps there. */
const requests: string[] = []
let kept = new Map<string, unknown>()
/** Answers as the API does an observer, who reads the page but keeps nothing in it. */
let observing = false
const original = client.getConfig()

beforeAll(() => {
  client.setConfig({
    baseUrl: "http://localhost:3002",
    fetch: Object.assign(
      async (input: Request) => {
        const url = new URL(input.url)
        const key = decodeURIComponent(url.pathname.split("/state/")[1] ?? "")
        requests.push(`${input.method} ${url.pathname}`)
        if (observing) {
          return Response.json(
            { error: "Observers keep no page data", code: "read_only" },
            { status: 403 }
          )
        }
        if (input.method === "GET") {
          return Response.json({
            entries: [...kept].map(([entry, value]) => ({
              key: entry,
              value,
              updatedAt: "2026-10-19T12:00:00.000Z",
            })),
          })
        }
        if (input.method === "PUT") {
          const { value } = (await input.json()) as { value: unknown }
          kept.set(key, value)
          return Response.json({ key, value, updatedAt: "2026-10-19T12:00:00.000Z" })
        }
        if (key) return Response.json({ deleted: kept.delete(key) })
        const cleared = kept.size
        kept = new Map()
        return Response.json({ cleared })
      },
      { preconnect: globalThis.fetch.preconnect }
    ) as unknown as typeof fetch,
  })
})
afterAll(() => {
  client.setConfig(original)
})
beforeEach(() => {
  observing = false
  requests.length = 0
  kept = new Map([["inputs", { rate: 412, occupancy: 88 }]])
})

function mount(artifactId = PAGE) {
  const version = { ...pageVersion(), artifactId }
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  cache.setQueryData(["artifact-frame", version.artifactId, version.version], {
    path: "/api/artifact-frames/token/",
    expiresAt: "2026-10-19T13:00:00.000Z",
  })
  const ui = render(
    <QueryClientProvider client={cache}>
      <ArtifactFrame version={version} title="Lisbon rate what-if" />
    </QueryClientProvider>
  )
  const frame = ui.container.querySelector("iframe")?.contentWindow
  if (!frame) throw new Error("Expected the page's frame.")
  const posted: Record<string, unknown>[] = []
  frame.postMessage = ((message: Record<string, unknown>) => {
    posted.push(message)
  }) as never
  /** Posts as a window, the frame's own unless another is named, and lets the answer arrive. */
  const call = async (data: Record<string, unknown>, source: unknown = frame): Promise<void> => {
    await act(async () => {
      browser.dispatchEvent(
        new browser.MessageEvent("message", {
          data: { protocol: FRAME_PROTOCOL, ...data },
          source: source as never,
        })
      )
      await Bun.sleep(20)
    })
  }
  const results = () => posted.filter((message) => "result" in message)
  /** Where the frame mounted now loads its page. */
  const source = () => ui.container.querySelector("iframe")?.getAttribute("src")
  return { cache, posted, call, results, source }
}

describe("a page's data", () => {
  test("is read once, written through the API in the order the page wrote it, and read back", async () => {
    const { call, results } = mount()
    await call({ call: 1, method: "state.get", params: { key: "inputs" } })
    await call({ call: 2, method: "state.set", params: { key: "inputs", value: { rate: 450 } } })
    await call({ call: 3, method: "state.set", params: { key: "pinned", value: [{ rate: 476 }] } })
    await call({ call: 4, method: "state.get", params: { key: "inputs" } })
    await call({ call: 5, method: "state.keys", params: {} })
    await call({ call: 6, method: "state.delete", params: { key: "pinned" } })
    expect(results()).toEqual([
      { protocol: FRAME_PROTOCOL, result: 1, value: { rate: 412, occupancy: 88 } },
      { protocol: FRAME_PROTOCOL, result: 2 },
      { protocol: FRAME_PROTOCOL, result: 3 },
      { protocol: FRAME_PROTOCOL, result: 4, value: { rate: 450 } },
      { protocol: FRAME_PROTOCOL, result: 5, value: ["inputs", "pinned"] },
      { protocol: FRAME_PROTOCOL, result: 6, value: true },
    ])
    expect(requests).toEqual([
      `GET /api/artifacts/${PAGE}/state`,
      `PUT /api/artifacts/${PAGE}/state/inputs`,
      `PUT /api/artifacts/${PAGE}/state/pinned`,
      `DELETE /api/artifacts/${PAGE}/state/pinned`,
    ])
  })

  test("answers only its own frame", async () => {
    // Reproduce by dropping the check of the message's source in ArtifactFrame: a page in another
    // frame writes into this one's data.
    const { call, results } = mount()
    const other = document.createElement("iframe")
    document.body.append(other)
    try {
      await call(
        { call: 1, method: "state.set", params: { key: "inputs", value: 1 } },
        other.contentWindow
      )
      expect(requests).toEqual([])
      expect(results()).toEqual([])
    } finally {
      other.remove()
    }
  })

  test("refuses what the protocol can't take without asking the API, and still answers", async () => {
    // Reproduce by dropping the size check from parseFrameCall: the 70 KB value goes to the API.
    const { call, results } = mount()
    await call({
      call: 1,
      method: "state.set",
      params: { key: "big", value: "x".repeat(70 * 1024) },
    })
    await call({ call: 2, method: "state.get", params: { key: "" } })
    await call({ call: 3, method: "state.clear", params: {} })
    expect(requests).toEqual([])
    expect(results().map((message) => [message.result, typeof message.error])).toEqual([
      [1, "string"],
      [2, "string"],
      [3, "string"],
    ])
  })

  test("reset deletes it, and the page starts over", async () => {
    const { cache, call, posted } = mount()
    await call({ call: 1, method: "state.get", params: { key: "inputs" } })
    await act(async () => {
      await resetPageState(cache, PAGE)
    })
    expect(requests.at(-1)).toBe(`DELETE /api/artifacts/${PAGE}/state`)
    expect(posted.some((message) => message.method === "reload")).toBe(true)
    await call({ call: 2, method: "state.get", params: { key: "inputs" } })
    expect(posted.at(-1)).toEqual({ protocol: FRAME_PROTOCOL, result: 2 })
  })

  test("reset loads the page again on the newest link, not the one the frame kept", async () => {
    // Reproduce by sending `reload` on a reset again: the page reloads on the link it opened with,
    // which lasts an hour, and shows "Not found" once that is over.
    const { cache, posted, source } = mount()
    expect(source()).toContain("/api/artifact-frames/token/")

    // Another frame of the version mints a newer link; this one keeps loading the page it has.
    act(() => {
      cache.setQueryData(["artifact-frame", PAGE, 1], {
        path: "/api/artifact-frames/renewed/",
        expiresAt: "2026-10-19T14:00:00.000Z",
      })
    })
    expect(source()).toContain("/api/artifact-frames/token/")

    await act(async () => {
      await resetPageState(cache, PAGE)
    })

    expect(source()).toContain("/api/artifact-frames/renewed/")
    expect(posted.some((message) => message.method === "reload")).toBe(false)
  })

  // Guard proof: drop the read_only catch from keptValues in page-state.ts; the page's first read
  // then rejects with the API's refusal.
  test("runs on this tab's values for an observer, without asking the API again", async () => {
    observing = true
    const { call, results } = mount("art_0bserved01")
    await call({ call: 1, method: "state.get", params: { key: "inputs" } })
    await call({ call: 2, method: "state.set", params: { key: "inputs", value: { rate: 450 } } })
    await call({ call: 3, method: "state.get", params: { key: "inputs" } })
    await call({ call: 4, method: "state.keys", params: {} })

    expect(results()).toEqual([
      { protocol: FRAME_PROTOCOL, result: 1 },
      { protocol: FRAME_PROTOCOL, result: 2 },
      { protocol: FRAME_PROTOCOL, result: 3, value: { rate: 450 } },
      { protocol: FRAME_PROTOCOL, result: 4, value: ["inputs"] },
    ])
    expect(requests).toEqual([`GET /api/artifacts/art_0bserved01/state`])
  })

  // Guard proof: keep the observed pages whoever signs in, as one set for the tab; Marc's write,
  // once he signs in where Olivia observed, then stays in the tab and never reaches the API.
  test("forgets what an observer kept once another reader signs in, whose writes are kept", async () => {
    observing = true
    const { cache, call, results } = mount("art_0bserved02")
    const signIn = (id: string) =>
      act(() => {
        cache.setQueryData(getAuthSessionQueryKey(), {
          authenticated: true,
          user: { id },
        } as never)
      })
    signIn("usr_olivia")
    await call({ call: 1, method: "state.set", params: { key: "inputs", value: { rate: 450 } } })
    expect(requests).toEqual(["GET /api/artifacts/art_0bserved02/state"])

    observing = false
    signIn("usr_marc")
    await call({ call: 2, method: "state.set", params: { key: "inputs", value: { rate: 476 } } })
    expect(results().at(-1)).toEqual({ protocol: FRAME_PROTOCOL, result: 2 })
    expect(requests.at(-1)).toBe("PUT /api/artifacts/art_0bserved02/state/inputs")
  })
})
