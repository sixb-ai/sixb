import { afterEach, expect, test } from "bun:test"
import {
  BRANCH_HANDOVER_PREPARE_PATH,
  BRANCH_KEY_HEADER,
  BRANCH_STATUS_PATH,
} from "@sixb/core/internal/branches"
import { startBranchFront } from "../src/lib/dev-branch"

const stops: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
})

const KEY = "k".repeat(43)

/** A branch's front, its API and its app, each answering with its own name. */
function setup() {
  const keys: (string | null)[] = []
  const api = Bun.serve({
    port: 0,
    fetch: (request) => {
      keys.push(request.headers.get(BRANCH_KEY_HEADER))
      // The branch's API refuses a session it does not know.
      const refused = request.headers.get("cookie") === "sixb_session_app=expired"
      return new Response("api", { status: refused ? 401 : 200 })
    },
  })
  const app = Bun.serve({ port: 0, fetch: () => new Response("app") })
  stops.push(
    async () => api.stop(true),
    async () => app.stop(true)
  )
  const front = startBranchFront({
    branch: "feature/invoices",
    key: KEY,
    host: "127.0.0.1",
    port: 0,
    apiPort: api.port!,
    appPort: app.port!,
    root: process.cwd(),
  })
  stops.push(() => front.stop())

  const call = (path: string, key: string | null = KEY, cookie?: string) =>
    fetch(`http://127.0.0.1:${front.port}${path}`, {
      headers: { ...(key ? { [BRANCH_KEY_HEADER]: key } : {}), ...(cookie ? { cookie } : {}) },
    })
  const status = async () => (await (await call(BRANCH_STATUS_PATH)).json()) as { requests: number }
  return { front, call, status, keys }
}

// Production stops a branch nobody uses, and learns of its use from this count only: a crawler,
// a refused session or the "starting" page keeps no branch up. Guard check: count every request
// `fetch` forwards in `dev-branch.ts`, or none.
test("counts what the API accepts from a signed-in browser as use, and nothing else", async () => {
  const { front, call, status } = setup()

  expect((await call("/api/objects", null, "sixb_session_app=live")).status).toBe(503)
  front.reporter.message({ type: "ready", watchesApp: false, app: null }, undefined)
  expect((await status()).requests).toBe(0)

  expect((await call("/api/objects", null)).status).toBe(200)
  expect((await call("/api/objects", null, "sixb_session_app=expired")).status).toBe(401)
  expect((await status()).requests).toBe(0)

  expect((await call("/api/objects", null, "sixb_session_app=live")).status).toBe(200)
  expect((await status()).requests).toBe(1)
})

// After a refresh, a tab left open keeps reconnecting its socket with a session the new copy does
// not know: the branch refuses it, and it keeps nothing up. Red check: count a socket as the front
// upgrades it, not once the API accepts it, in `dev-branch.ts`.
test("counts a socket as use once the API accepts it", async () => {
  const api = Bun.serve<undefined>({
    port: 0,
    fetch: (request, server) => {
      if (request.headers.get("cookie") === "sixb_session_app=expired") {
        return new Response("Unauthorized", { status: 401 })
      }
      return server.upgrade(request, { data: undefined }) ? undefined : new Response("no")
    },
    websocket: {
      open: (ws) => {
        ws.send("open")
      },
      message: () => undefined,
    },
  })
  stops.push(async () => api.stop(true))
  const front = startBranchFront({
    branch: "feature/invoices",
    key: KEY,
    host: "127.0.0.1",
    port: 0,
    apiPort: api.port!,
    appPort: api.port!,
    root: process.cwd(),
  })
  stops.push(() => front.stop())
  front.reporter.message({ type: "ready", watchesApp: false, app: null }, undefined)

  const requests = async () => {
    const response = await fetch(`http://127.0.0.1:${front.port}${BRANCH_STATUS_PATH}`, {
      headers: { [BRANCH_KEY_HEADER]: KEY },
    })
    return ((await response.json()) as { requests: number }).requests
  }
  const connect = (cookie: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${front.port}/ws/events`, {
      headers: { cookie },
    } as never)
    return new Promise<"open" | "closed">((resolve) => {
      socket.addEventListener("message", () => {
        resolve("open")
        socket.close()
      })
      socket.addEventListener("close", () => resolve("closed"))
    })
  }

  expect(await connect("sixb_session_app=expired")).toBe("closed")
  expect(await requests()).toBe(0)

  expect(await connect("sixb_session_app=ada")).toBe("open")
  expect(await requests()).toBe(1)
})

// People reach a branch on its own origin now, signed in by its own sessions; its status and the
// handover's preparation stay production's. Guard check: let every path through without the key
// in `fetch` (`dev-branch.ts`), or forward the key everywhere.
test("takes the key for production's paths only, and passes it on to the handover alone", async () => {
  const { front, call, keys } = setup()
  front.reporter.message({ type: "ready", watchesApp: false, app: null }, undefined)

  expect((await call(BRANCH_STATUS_PATH, null)).status).toBe(401)
  expect((await call(BRANCH_HANDOVER_PREPARE_PATH, null)).status).toBe(401)

  await call("/api/objects")
  await call(BRANCH_HANDOVER_PREPARE_PATH)
  expect(keys).toEqual([null, KEY])
})

// A preview is the project's app on the branch's data: the front serves it beside the API.
// Guard check: send every path to the API in `upstream` (`dev-branch.ts`).
test("serves the project's app, and the API's paths from the API", async () => {
  const { front, call } = setup()
  front.reporter.message(
    {
      type: "ready",
      watchesApp: true,
      app: { url: "http://127.0.0.1", apiOrigin: "http://127.0.0.1" },
    },
    undefined
  )

  expect(await (await call("/")).text()).toBe("app")
  expect(await (await call("/invoices/42")).text()).toBe("app")
  expect(await (await call("/api/objects")).text()).toBe("api")
  expect(await (await call("/auth/sign-in")).text()).toBe("api")
  expect(await (await call("/health")).text()).toBe("api")
})

// The app serves its own framework files under `/__sixb/`: connector icons and live reload.
// Guard check: add "/__sixb/" back to `BRANCH_API_PREFIXES` in `core/src/branches/runtime.ts`.
test("leaves the app's own /__sixb/ files to the app, and answers its status itself", async () => {
  const { front, call } = setup()
  front.reporter.message(
    {
      type: "ready",
      watchesApp: true,
      app: { url: "http://127.0.0.1", apiOrigin: "http://127.0.0.1" },
    },
    undefined
  )

  expect(await (await call("/__sixb/assets/connector-icons/github.svg")).text()).toBe("app")
  expect(await (await call("/__sixb/dev-reload.js")).text()).toBe("app")

  const status = (await (await call(BRANCH_STATUS_PATH)).json()) as { state: string }
  expect(status.state).toBe("ready")
})

test("sends everything to the API when the project has no app", async () => {
  const { front, call } = setup()
  front.reporter.message({ type: "ready", watchesApp: false, app: null }, undefined)

  expect(await (await call("/")).text()).toBe("api")
})

// A page's socket authenticates by its session cookie, and the API checks its origin. Guard check:
// open the upstream socket without `ws.data.handshake` (`dev-branch.ts`): the API sees no cookie.
test("passes a page's socket on with its cookie, origin and subprotocol, never the key", async () => {
  const seen: Record<string, string | null>[] = []
  const api = Bun.serve<undefined>({
    port: 0,
    fetch: (request, server) => {
      seen.push({
        cookie: request.headers.get("cookie"),
        origin: request.headers.get("origin"),
        key: request.headers.get(BRANCH_KEY_HEADER),
        protocol: request.headers.get("sec-websocket-protocol"),
      })
      return server.upgrade(request, {
        headers: { "sec-websocket-protocol": "sixb.v1" },
        data: undefined,
      })
        ? undefined
        : new Response("no", { status: 400 })
    },
    websocket: {
      open: (ws) => {
        ws.send("open")
      },
      message: () => undefined,
    },
  })
  stops.push(async () => api.stop(true))
  const front = startBranchFront({
    branch: "feature/invoices",
    key: KEY,
    host: "127.0.0.1",
    port: 0,
    apiPort: api.port!,
    appPort: api.port!,
    root: process.cwd(),
  })
  stops.push(() => front.stop())
  front.reporter.message({ type: "ready", watchesApp: false, app: null }, undefined)

  const socket = new WebSocket(`ws://127.0.0.1:${front.port}/ws/events`, {
    headers: {
      cookie: "sixb_session_app=ada",
      origin: "https://feature-invoices.preview.shop.test",
      [BRANCH_KEY_HEADER]: KEY,
    },
    protocols: ["sixb.v1"],
  } as never)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("message", () => resolve())
    socket.addEventListener("error", () => reject(new Error("socket failed")))
  })
  socket.close()

  expect(seen).toEqual([
    {
      cookie: "sixb_session_app=ada",
      origin: "https://feature-invoices.preview.shop.test",
      key: null,
      protocol: "sixb.v1",
    },
  ])
})
