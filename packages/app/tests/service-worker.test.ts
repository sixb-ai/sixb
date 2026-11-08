import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startupChunks } from "../src/build"
import { renderServiceWorker } from "../src/service-worker"

const ORIGIN = "https://app.example.com"

/** A Request that resolves a path against the worker's origin, as a browser does. */
class WorkerRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit & { mode?: RequestMode }) {
    super(typeof input === "string" ? new URL(input, ORIGIN).href : input, init)
    if (init?.mode) Object.defineProperty(this, "mode", { value: init.mode })
  }
}

/** A same-origin response, which a browser marks `basic`, and so do its clones. */
function basic(body: string, contentType = "text/html; charset=utf-8", status = 200): Response {
  return markBasic(new Response(body, { status, headers: { "content-type": contentType } }))
}

function markBasic(response: Response): Response {
  const clone = response.clone.bind(response)
  Object.defineProperty(response, "type", { value: "basic" })
  Object.defineProperty(response, "clone", { value: () => markBasic(clone()) })
  return response
}

/** In-memory CacheStorage keyed by URL. */
function cacheStorage() {
  const stores = new Map<string, Map<string, Response>>()
  const keyOf = (request: RequestInfo) =>
    new URL(typeof request === "string" ? request : request.url, ORIGIN).href
  const open = async (name: string) => {
    const store = stores.get(name) ?? new Map<string, Response>()
    stores.set(name, store)
    return {
      match: async (request: RequestInfo) => store.get(keyOf(request))?.clone(),
      put: async (request: RequestInfo, response: Response) => {
        store.set(keyOf(request), response)
      },
      add: async (request: RequestInfo) => {
        store.set(keyOf(request), basic(`saved ${keyOf(request)}`, "text/plain"))
      },
    }
  }
  return {
    stores,
    api: {
      open,
      // Across every cache, oldest first, as the browser's does.
      match: async (request: RequestInfo) => {
        for (const store of stores.values()) {
          const saved = store.get(keyOf(request))
          if (saved) return saved.clone()
        }
        return undefined
      },
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
    },
  }
}

type Network = (request: Request) => Promise<Response>

/** Runs the generated worker against a fake browser, with `network` standing in for fetch. */
function startWorker(options: { network: Network; version?: string; instantTimers?: boolean }) {
  const listeners = new Map<string, (event: unknown) => void>()
  const caches = cacheStorage()
  let skippedWaiting = false
  let preloading = false
  const self = {
    location: new URL(`${ORIGIN}/sixb-service-worker.js`),
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener)
    },
    skipWaiting: async () => {
      skippedWaiting = true
    },
    clients: { claim: async () => undefined },
    registration: {
      navigationPreload: {
        enable: async () => {
          preloading = true
        },
      },
    },
  }
  const source = renderServiceWorker({
    version: options.version ?? "v1",
    entry: "/app-abc123.js",
    precache: ["/app-abc123.js", "/favicon.svg"],
  })
  const timers = options.instantTimers
    ? (callback: () => void) => queueMicrotask(callback)
    : setTimeout
  new Function("self", "caches", "fetch", "setTimeout", "Request", "Response", source)(
    self,
    caches.api,
    (input: RequestInfo) => options.network(new WorkerRequest(input)),
    timers,
    WorkerRequest,
    Response
  )

  /** Dispatches an extendable event and, unless told not to, waits for everything it extends. */
  const dispatch = async (type: string, fields: Record<string, unknown> = {}, settle = true) => {
    const pending: Promise<unknown>[] = []
    let responded: Promise<Response> | undefined
    listeners.get(type)?.({
      ...fields,
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      respondWith: (response: Promise<Response>) => {
        responded = response
      },
    })
    const response = responded ? await responded : undefined
    if (settle) await Promise.all(pending)
    return response
  }

  return {
    caches,
    skippedWaiting: () => skippedWaiting,
    preloading: () => preloading,
    install: () => dispatch("install"),
    activate: () => dispatch("activate"),
    fetch: (
      url: string,
      mode: RequestMode = "no-cors",
      settle = true,
      preloadResponse?: Promise<Response | undefined>
    ) => dispatch("fetch", { request: new WorkerRequest(url, { mode }), preloadResponse }, settle),
  }
}

const SHELL = '<html><script src="/app-abc123.js"></script></html>'
const online: Network = async (request) =>
  new URL(request.url).pathname === "/"
    ? basic(SHELL)
    : basic(`network ${new URL(request.url).pathname}`, "text/plain")
const offline: Network = async () => {
  throw new TypeError("Load failed")
}

describe("the app's service worker", () => {
  test("installing saves the shell and the files it opens with, then takes over", async () => {
    const worker = startWorker({ network: online })
    await worker.install()

    const store = worker.caches.stores.get("sixb-app-v1")
    expect([...(store?.keys() ?? [])].sort()).toEqual([
      `${ORIGIN}/`,
      `${ORIGIN}/app-abc123.js`,
      `${ORIGIN}/favicon.svg`,
    ])
    expect(worker.skippedWaiting()).toBe(true)
  })

  test("a new version keeps the last one's files one more round, and leaves other caches alone", async () => {
    const worker = startWorker({ network: online, version: "v3" })
    await worker.caches.api.open("sixb-app-v1")
    await worker.caches.api.open("project-cache")
    await worker.caches.api.open("sixb-app-v2")
    await worker.install()
    await worker.activate()

    expect([...worker.caches.stores.keys()].sort()).toEqual([
      "project-cache",
      "sixb-app-v2",
      "sixb-app-v3",
    ])
  })

  test("a shell from another deploy is never saved", async () => {
    let network: Network = async () => basic('<html><script src="/app-other99.js"></script></html>')
    const worker = startWorker({ network: (request) => network(request) })
    await worker.install()
    expect(worker.caches.stores.get("sixb-app-v1")?.has(`${ORIGIN}/`)).toBe(false)

    network = online
    await worker.fetch("/", "navigate")
    network = offline
    expect(await (await worker.fetch("/quotes", "navigate"))?.text()).toBe(SHELL)
  })

  test("a hashed file the last version saved is found after a new one takes over", async () => {
    const worker = startWorker({ network: offline, version: "v2" })
    const last = await worker.caches.api.open("sixb-app-v1")
    await last.put("/chunk-quotes-aa11.js", basic("old chunk", "text/javascript"))
    await worker.activate()
    expect(await (await worker.fetch("/chunk-quotes-aa11.js"))?.text()).toBe("old chunk")
  })

  test("a page uses the response the browser asked for while the worker started", async () => {
    let calls = 0
    const worker = startWorker({
      network: async (request) => {
        calls++
        return online(request)
      },
    })
    await worker.install()
    await worker.activate()
    expect(worker.preloading()).toBe(true)

    calls = 0
    const page = await worker.fetch(
      "/equipment",
      "navigate",
      true,
      Promise.resolve(basic("preloaded /equipment"))
    )
    expect(await page?.text()).toBe("preloaded /equipment")
    expect(calls).toBe(0)
  })

  test("a page comes from the network, and from the device when the network fails", async () => {
    let network = online
    const worker = startWorker({ network: (request) => network(request) })
    await worker.install()

    const fresh = await worker.fetch("/service-cases/sc-1", "navigate")
    expect(await fresh?.text()).toBe("network /service-cases/sc-1")

    network = offline
    const saved = await worker.fetch("/service-cases/sc-1", "navigate")
    expect(await saved?.text()).toBe(SHELL)
  })

  test("a page the network is slow to send opens from the device", async () => {
    let network: Network = online
    const worker = startWorker({ network: (request) => network(request), instantTimers: true })
    await worker.install()

    network = () => new Promise<Response>(() => undefined)
    const page = await worker.fetch("/equipment", "navigate", false)
    expect(await page?.text()).toBe(SHELL)
  })

  test("only `/` refreshes the saved shell, and only with an HTML page", async () => {
    let network: Network = online
    const worker = startWorker({ network: (request) => network(request) })
    await worker.install()

    network = async () => basic("<html>a project page</html>")
    await worker.fetch("/about", "navigate")
    network = async () => basic("Server error", "text/plain", 500)
    await worker.fetch("/", "navigate")
    network = offline
    expect(await (await worker.fetch("/", "navigate"))?.text()).toBe(SHELL)
  })

  test("hashed files come from the device; others from the network first", async () => {
    let calls = 0
    let network: Network = async (request) => {
      calls++
      return online(request)
    }
    const worker = startWorker({ network: (request) => network(request) })
    await worker.install()
    calls = 0

    expect(await (await worker.fetch("/app-abc123.js"))?.text()).toBe(
      `saved ${ORIGIN}/app-abc123.js`
    )
    expect(calls).toBe(0)

    expect(await (await worker.fetch("/favicon.svg"))?.text()).toBe("network /favicon.svg")
    expect(calls).toBe(1)

    network = offline
    expect(await (await worker.fetch("/favicon.svg"))?.text()).toBe("network /favicon.svg")
  })

  test("the API, sign-in, shared links and other origins pass through untouched", async () => {
    const worker = startWorker({ network: online })
    for (const url of [
      "/api/v1/objects",
      "/auth/sign-in",
      "/shared/abc",
      "https://api.example.com/v1",
    ]) {
      expect(await worker.fetch(url, "navigate")).toBeUndefined()
    }
  })
})

// Regression proof: without startupChunks the worker saves only the entry, and the app opened offline
// after its first launch is blank once the browser's own cache lets the chunks go.
describe("the files a build has the worker save on install", () => {
  test("every chunk the entry imports as it loads, and theirs, but none loaded on demand", async () => {
    const outdir = await mkdtemp(join(tmpdir(), "sixb-startup-chunks-"))
    try {
      const files: Record<string, string> = {
        "app-abc123.js":
          'import{a}from"/chunk-main-aa11.js";import"/chunk-main-bb22.js";import("/chunk-chart-cc33.js")',
        "chunk-main-aa11.js": 'import{b}from "/chunk-main-dd44.js";export const a=1',
        "chunk-main-bb22.js": 'import{a}from"/chunk-main-aa11.js"',
        "chunk-main-dd44.js": "export const b=2",
        "chunk-chart-cc33.js": 'import{c}from"/chunk-lazy-ee55.js"',
      }
      for (const [name, source] of Object.entries(files)) {
        await writeFile(join(outdir, name), source)
      }
      expect((await startupChunks(outdir, "/app-abc123.js")).sort()).toEqual([
        "/chunk-main-aa11.js",
        "/chunk-main-bb22.js",
        "/chunk-main-dd44.js",
      ])
    } finally {
      await rm(outdir, { recursive: true, force: true })
    }
  })
})
