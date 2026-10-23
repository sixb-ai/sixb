import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { client, type GetArtifactVersionResponse } from "@sixb/client"
import { FRAME_PROTOCOL } from "@sixb/core/artifacts"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render } from "@testing-library/react"
import { ArtifactFrame } from "../src/artifacts/frame"
import { artifactQueryKey } from "../src/artifacts/queries"
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

const PAGE = "art_0verdue001"

function pageVersion(version: number): GetArtifactVersionResponse {
  return {
    artifactId: PAGE,
    version,
    title: "Overdue invoices",
    entry: "index.html",
    files: [],
    outline: { kind: "page", title: "Overdue invoices" },
    references: [],
    author: { type: "user", id: "user-1" },
    createdAt: "2026-10-23T12:00:00.000Z",
  }
}

/** The rows a version's `overdue` query returns: each version's are its own. */
function overdue(version: number) {
  return {
    kind: "objects",
    objects: [
      {
        primaryId: `inv-v${version}`,
        objectTypeId: "Invoice",
        properties: { amount: 1200 * version },
        createdAt: "2026-10-23T12:00:00.000Z",
        updatedAt: "2026-10-23T12:00:00.000Z",
      },
    ],
    total: 1,
    truncated: false,
    resultObjectTypeIds: ["Invoice"],
    readObjectTypeIds: ["Invoice"],
    schema: { properties: { amount: { type: "double" } }, links: {} },
  }
}

/** What the frames' calls asked of the API. */
const requests: string[] = []
const original = client.getConfig()

beforeAll(() => {
  client.setConfig({
    baseUrl: "http://localhost:3002",
    fetch: Object.assign(
      async (input: Request) => {
        const url = new URL(input.url)
        requests.push(`${input.method} ${url.pathname}`)

        // Version 2 is the latest.
        const [, at, name] = /\/versions\/(\d+|latest)\/queries\/([^/]+)$/.exec(url.pathname) ?? []
        const version = at === "latest" ? 2 : Number(at)
        if (name === "overdue") return Response.json(overdue(version))

        return Response.json(
          {
            error: `[Sixb] Version ${version} of artifact '${PAGE}' has no query '${name}'.`,
            code: "query_not_found",
          },
          { status: 404 }
        )
      },
      { preconnect: globalThis.fetch.preconnect }
    ) as unknown as typeof fetch,
  })
})
afterAll(() => {
  client.setConfig(original)
})
beforeEach(() => {
  requests.length = 0
})

/** The versions' frames, mounted side by side as a version's history shows them. */
function mount(versions: readonly number[]) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  for (const version of versions) {
    cache.setQueryData(["artifact-frame", PAGE, version], {
      path: `/api/artifact-frames/token-v${version}/`,
      expiresAt: "2026-10-23T13:00:00.000Z",
    })
  }

  const ui = render(
    <QueryClientProvider client={cache}>
      {versions.map((version, index) => (
        <ArtifactFrame key={index} version={pageVersion(version)} title="Overdue invoices" />
      ))}
    </QueryClientProvider>
  )

  return [...ui.container.querySelectorAll("iframe")].map((iframe) => {
    const frame = iframe.contentWindow
    if (!frame) throw new Error("Expected the page's frame.")

    const results: Record<string, unknown>[] = []
    const waiting = new Map<number, () => void>()
    frame.postMessage = ((message: Record<string, unknown>) => {
      if (!("result" in message)) return
      results.push(message)
      waiting.get(Number(message.result))?.()
    }) as never

    /** Posts a call as this frame, and waits for its answer. */
    const call = async (id: number, method: string, params: Record<string, unknown>) => {
      await act(async () => {
        const answered = new Promise<void>((resolve) => waiting.set(id, resolve))
        browser.dispatchEvent(
          new browser.MessageEvent("message", {
            data: { protocol: FRAME_PROTOCOL, call: id, method, params },
            source: frame as never,
          })
        )
        await answered
      })
    }
    return { results, call, cache }
  })
}

describe("a page's queries", () => {
  test("run for the version its frame shows, answered to that frame only", async () => {
    // Reproduce by running the query at the artifact's latest version in answerQueryCall: the
    // first frame gets version 2's rows.
    const [first, second] = mount([1, 2])
    if (!first || !second) throw new Error("Expected both versions' frames.")

    await second.call(1, "query.run", { name: "overdue" })
    await first.call(1, "query.run", { name: "overdue" })

    expect(first.results).toEqual([{ protocol: FRAME_PROTOCOL, result: 1, value: overdue(1) }])
    expect(second.results).toEqual([{ protocol: FRAME_PROTOCOL, result: 1, value: overdue(2) }])
    expect(requests).toEqual([
      `GET /api/artifacts/${PAGE}/versions/2/queries/overdue`,
      `GET /api/artifacts/${PAGE}/versions/1/queries/overdue`,
    ])
  })

  test("are read once for the frames of a version that ask together", async () => {
    // A deck's stage and its filmstrip run the same scripts as they load, and a live sheet of the
    // version reads the same entry. Reproduce by dropping the stale time in fetchArtifactQuery:
    // the second frame reads the query again.
    const [stage, thumbnail] = mount([1, 1])
    await stage?.call(1, "query.run", { name: "overdue" })
    await thumbnail?.call(1, "query.run", { name: "overdue" })

    expect(thumbnail?.results).toEqual([{ protocol: FRAME_PROTOCOL, result: 1, value: overdue(1) }])
    expect(requests).toEqual([`GET /api/artifacts/${PAGE}/versions/1/queries/overdue`])
    expect(stage?.cache.getQueryData<unknown>(artifactQueryKey(PAGE, 1, "overdue"))).toEqual(
      overdue(1)
    )
  })

  test("reject in the API's words for a query the version does not hold", async () => {
    // Reproduce by rejecting with the client's error as it is: the page reads the client's
    // message, not which query is missing.
    const [frame] = mount([1])
    await frame?.call(1, "query.run", { name: "missing" })

    expect(frame?.results).toEqual([
      {
        protocol: FRAME_PROTOCOL,
        result: 1,
        error: `[Sixb] Version 1 of artifact '${PAGE}' has no query 'missing'.`,
      },
    ])
  })

  test("refuse a name that is not a query's without asking the API, and still answer", async () => {
    const [frame] = mount([1])
    await frame?.call(1, "query.run", { name: "../state" })

    expect(requests).toEqual([])
    expect(frame?.results).toEqual([
      { protocol: FRAME_PROTOCOL, result: 1, error: "[SixbApp] sixb.query refused the call." },
    ])
  })
})
