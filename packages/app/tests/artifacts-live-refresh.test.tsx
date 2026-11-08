import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "bun:test"
import { client, type GetArtifactVersionResponse } from "@sixb/client"
import { SixbEventsProvider } from "@sixb/client/hooks"
import { FRAME_PROTOCOL } from "@sixb/core/artifacts"
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render } from "@testing-library/react"
import type { ReactNode } from "react"
import { ArtifactFrame, frameLinkKey } from "../src/artifacts/frame"
import {
  artifactVersionOptions,
  LIVE_QUERY_DEBOUNCE_MS,
  useArtifactQuery,
  useArtifactUpdates,
  useArtifactVersion,
} from "../src/artifacts/queries"
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

const version: GetArtifactVersionResponse = {
  artifactId: PAGE,
  version: 1,
  title: "Overdue invoices",
  entry: "index.html",
  files: [],
  outline: { kind: "page", title: "Overdue invoices" },
  references: [],
  author: { type: "user", id: "user-1" },
  createdAt: "2026-10-23T12:00:00.000Z",
  updatedAt: "2026-10-23T12:00:00.000Z",
  revision: 1,
  frozen: true,
}

/** What each query reads: `overdue` its invoices and their customers, `paid` the payments. */
const READS: Readonly<Record<string, readonly string[]>> = {
  overdue: ["Invoice", "Customer"],
  paid: ["Payment"],
}

/** The queries the views read, in order; each read's rows are new, as after a change. */
const requests: string[] = []

const original = client.getConfig()
beforeAll(() => {
  // The cache tells its views on a timer of its own by default: here, as soon as the read is in,
  // so the fake clock moves only where a test moves it.
  notifyManager.setScheduler(queueMicrotask)
  client.setConfig({
    baseUrl: "http://localhost:3002",
    fetch: Object.assign(
      async (input: Request) => {
        const name = new URL(input.url).pathname.split("/").at(-1) ?? ""
        requests.push(name)

        return Response.json({
          kind: "objects",
          objects: [],
          total: requests.length,
          truncated: false,
          resultObjectTypeIds: READS[name]?.slice(0, 1) ?? [],
          readObjectTypeIds: READS[name] ?? [],
          schema: { properties: {}, links: {} },
        })
      },
      { preconnect: globalThis.fetch.preconnect }
    ) as unknown as typeof fetch,
  })
})
afterAll(() => {
  client.setConfig(original)
  notifyManager.setScheduler((callback) => setTimeout(callback, 0))
})

/** The event socket the app's provider opens: the test speaks for the server. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  constructor() {
    FakeWebSocket.instances.push(this)
  }

  send(): void {}

  close(): void {}
}

const originalWebSocket = globalThis.WebSocket
let cursor = 0

beforeEach(() => {
  requests.length = 0
  FakeWebSocket.instances = []
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  jest.useFakeTimers()
})
afterEach(() => {
  jest.useRealTimers()
  globalThis.WebSocket = originalWebSocket
})

/** Lets the reads, renders and socket the last step started finish, the clock where it is. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
  })
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms)
  })
  await settle()
}

/** An object of `type` changed, as the server tells every socket. */
function objectUpdated(type: string) {
  cursor += 1
  return {
    id: `evt-${cursor}`,
    cursor: `c${cursor}`,
    projectId: "project",
    occurredAt: "2026-10-23T12:00:00.000Z",
    type: "object.updated",
    topic: "objects",
    partitionKey: `${type}:1`,
    payload: { objectTypeId: type, primaryId: "1", properties: {}, propertyChanges: {} },
  }
}

function linkCreated(sourceTypeId: string, targetTypeId: string) {
  cursor += 1
  return {
    id: `evt-${cursor}`,
    cursor: `c${cursor}`,
    projectId: "project",
    occurredAt: "2026-10-23T12:00:00.000Z",
    type: "link.created",
    topic: "links",
    partitionKey: `${sourceTypeId}:1:customer`,
    payload: {
      sourceTypeId,
      sourceId: "1",
      linkId: "customer",
      targetTypeId,
      targetId: "2",
      propertyChanges: {},
    },
  }
}

/** An artifact changed, as the server tells whoever may read it. */
function artifactUpdated(artifactId: string, revision: number) {
  cursor += 1
  return {
    id: `evt-${cursor}`,
    cursor: `c${cursor}`,
    projectId: "project",
    occurredAt: "2026-10-23T12:00:00.000Z",
    type: "artifact.updated",
    topic: "artifacts",
    partitionKey: artifactId,
    payload: { artifactId, version: 1, revision, frozen: false },
  }
}

async function publish(...events: readonly unknown[]): Promise<void> {
  const [socket, ...more] = FakeWebSocket.instances
  if (!socket) throw new Error("Expected the provider's socket.")
  expect(more).toHaveLength(0)

  await act(async () => {
    for (const event of events)
      socket.onmessage?.({ data: JSON.stringify({ type: "event", event }) })
  })
}

function mount(children: ReactNode) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  cache.setQueryData(frameLinkKey({ artifactId: PAGE, version: 1, revision: 1 }), {
    path: "/api/artifact-frames/token-v1/",
    expiresAt: "2026-10-23T13:00:00.000Z",
  })

  const ui = render(
    <QueryClientProvider client={cache}>
      <SixbEventsProvider>{children}</SixbEventsProvider>
    </QueryClientProvider>
  )
  return { ui, cache }
}

/** A view that shows one of the version's queries, as a live sheet does. */
function Sheet({ name }: { readonly name: string | null }) {
  const { result } = useArtifactQuery(version, name)
  return <output>{result?.total}</output>
}

/** What each frame was asked by the app, and a way to call it as its page. */
function frames(container: HTMLElement) {
  return [...container.querySelectorAll("iframe")].map((iframe) => {
    const frame = iframe.contentWindow
    if (!frame) throw new Error("Expected the page's frame.")

    const asked: { method: unknown; params: unknown }[] = []
    frame.postMessage = ((message: Record<string, unknown>) => {
      if ("method" in message) asked.push({ method: message.method, params: message.params })
    }) as never

    const query = async (call: number, name: string) => {
      await act(async () => {
        browser.dispatchEvent(
          new browser.MessageEvent("message", {
            data: { protocol: FRAME_PROTOCOL, call, method: "query.run", params: { name } },
            source: frame as never,
          })
        )
      })
      await settle()
    }
    return { asked, query }
  })
}

describe("a live artifact's queries", () => {
  test("are read again once, a second after the objects they read change", async () => {
    // A negative check that can fail: the change to a type the query does not read comes first,
    // and is let through, so a refetch it caused would count. Reproduce by refetching every
    // cached query in readAgain: Payment's change reads `overdue` again too.
    mount(<Sheet name="overdue" />)
    await settle()
    expect(requests).toEqual(["overdue"])

    await publish(objectUpdated("Payment"))
    await wait(LIVE_QUERY_DEBOUNCE_MS)
    expect(requests).toEqual(["overdue"])

    await publish(objectUpdated("Invoice"))
    await wait(LIVE_QUERY_DEBOUNCE_MS - 1)
    expect(requests).toEqual(["overdue"])

    await wait(1)
    expect(requests).toEqual(["overdue", "overdue"])
  })

  test("are read again once for a burst of changes, however many views show them", async () => {
    // Reproduce by flushing each event as it arrives, or by keeping the pending changes per view:
    // the query is read once per event, or once per view, each read cancelling the one before.
    const { ui } = mount(
      <>
        <Sheet name="overdue" />
        <Sheet name="overdue" />
      </>
    )
    await settle()
    expect(requests).toEqual(["overdue"])

    await publish(
      objectUpdated("Invoice"),
      objectUpdated("Customer"),
      objectUpdated("Invoice"),
      objectUpdated("Invoice")
    )
    await wait(LIVE_QUERY_DEBOUNCE_MS)
    await wait(LIVE_QUERY_DEBOUNCE_MS)

    expect(requests).toEqual(["overdue", "overdue"])
    expect(
      [...ui.container.querySelectorAll("output")].map((output) => output.textContent)
    ).toEqual(["2", "2"])
  })

  test("are read again when a link from or to a type they read changes", async () => {
    // Reproduce by reading only the link's source type: a payment linked to a customer leaves
    // `overdue`, which reads customers, as it was.
    mount(<Sheet name="overdue" />)
    await settle()

    await publish(linkCreated("Payment", "Customer"))
    await wait(LIVE_QUERY_DEBOUNCE_MS)
    expect(requests).toEqual(["overdue", "overdue"])

    await publish(linkCreated("Invoice", "Payment"))
    await wait(LIVE_QUERY_DEBOUNCE_MS)
    expect(requests).toEqual(["overdue", "overdue", "overdue"])
  })

  test("tell the frame whose page read one that its rows changed, and only that frame", async () => {
    // Reproduce by sending `query.changed` to the frame for every query of its version: the
    // frame that read `paid` hears about `overdue` too.
    const { ui } = mount(
      <>
        <ArtifactFrame version={version} title="Overdue invoices" />
        <ArtifactFrame version={version} title="Overdue invoices" />
      </>
    )
    const [overdue, paid] = frames(ui.container)
    if (!overdue || !paid) throw new Error("Expected both frames.")

    await overdue.query(1, "overdue")
    await paid.query(1, "paid")
    expect(requests).toEqual(["overdue", "paid"])

    await publish(objectUpdated("Invoice"))
    await wait(LIVE_QUERY_DEBOUNCE_MS)

    expect(requests).toEqual(["overdue", "paid", "overdue"])
    expect(overdue.asked).toEqual([{ method: "query.changed", params: { name: "overdue" } }])
    expect(paid.asked).toEqual([])
  })

  test("subscribe to nothing while no view shows one", async () => {
    // Reproduce by enabling the live updates whatever the view reads: the provider opens its
    // socket for a frame whose page read no query.
    const { ui } = mount(
      <>
        <Sheet name={null} />
        <ArtifactFrame version={version} title="Overdue invoices" />
      </>
    )
    frames(ui.container)
    await settle()
    expect(FakeWebSocket.instances).toHaveLength(0)

    ui.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <SixbEventsProvider>
          <Sheet name="overdue" />
        </SixbEventsProvider>
      </QueryClientProvider>
    )
    await settle()
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})

describe("an artifact the reader has open", () => {
  /** The open version, as a view shows it: its revision. */
  function Current() {
    useArtifactUpdates(PAGE)
    const { data } = useArtifactVersion(PAGE, 1)
    return <output>{data?.revision}</output>
  }

  test("is read again when it changes, and not when another artifact does", async () => {
    // Reproduce by dropping useArtifactUpdates from the view: it reads the version once, and shows
    // revision 1 after the change.
    const reads: string[] = []
    const previous = client.getConfig().fetch
    client.setConfig({
      fetch: Object.assign(
        async (input: Request) => {
          reads.push(new URL(input.url).pathname)
          return Response.json({ ...version, revision: reads.length })
        },
        { preconnect: globalThis.fetch.preconnect }
      ) as unknown as typeof fetch,
    })
    try {
      const { ui } = mount(<Current />)
      await settle()
      expect(reads).toEqual([`/api/artifacts/${PAGE}/versions/1`])

      await publish(artifactUpdated("art_0th3r00001", 7))
      await settle()
      expect(reads).toHaveLength(1)

      await publish(artifactUpdated(PAGE, 2))
      await settle()
      expect(reads).toHaveLength(2)
      expect(ui.container.textContent).toBe("2")
    } finally {
      client.setConfig({ fetch: previous })
    }
  })

  test("is read again once a list knows a later revision of it", async () => {
    // A gallery's card knows the artifact's revision from the list. Reproduce by dropping the
    // revision check from useArtifactVersion: the card keeps revision 1.
    const reads: string[] = []
    const previous = client.getConfig().fetch
    client.setConfig({
      fetch: Object.assign(
        async (input: Request) => {
          reads.push(new URL(input.url).pathname)
          return Response.json({ ...version, frozen: false, revision: reads.length })
        },
        { preconnect: globalThis.fetch.preconnect }
      ) as unknown as typeof fetch,
    })
    function Card({ known }: { readonly known: number }) {
      const { data } = useArtifactVersion(PAGE, 1, { revision: known })
      return <output>{data?.revision}</output>
    }
    try {
      const { ui, cache } = mount(<Card known={1} />)
      await settle()
      expect(ui.container.textContent).toBe("1")

      ui.rerender(
        <QueryClientProvider client={cache}>
          <SixbEventsProvider>
            <Card known={2} />
          </SixbEventsProvider>
        </QueryClientProvider>
      )
      await settle()
      expect(reads).toHaveLength(2)
      expect(ui.container.textContent).toBe("2")
    } finally {
      client.setConfig({ fetch: previous })
    }
  })
})

describe("a created version", () => {
  test("is read once by its number, and again as the latest", async () => {
    // The next write after it opens a newer version, which `latest` names then. Reproduce by
    // keeping every frozen read fresh in artifactVersionOptions: `latest` is not read again.
    const reads: string[] = []
    const previous = client.getConfig().fetch
    client.setConfig({
      fetch: Object.assign(
        async (input: Request) => {
          reads.push(new URL(input.url).pathname)
          return Response.json(version)
        },
        { preconnect: globalThis.fetch.preconnect }
      ) as unknown as typeof fetch,
    })
    try {
      const cache = new QueryClient()
      const minuteAgo = Date.now() - 60_000
      for (const at of [1, "latest"] as const) {
        const options = artifactVersionOptions(PAGE, at)
        cache.setQueryData(options.queryKey, version, { updatedAt: minuteAgo })
        await cache.fetchQuery(options)
      }

      expect(reads).toEqual([`/api/artifacts/${PAGE}/versions/latest`])
    } finally {
      client.setConfig({ fetch: previous })
    }
  })
})
