import { afterEach, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectFileOf } from "../src/commands/dev-runner"
import {
  BRANCH_KEY_HEADER,
  BRANCH_STATUS_PATH,
  type BranchRuntimeStatus,
  startBranchFront,
} from "../src/lib/dev-branch"

const KEY = "k".repeat(40)

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const { port } = listener
  listener.stop(true)
  return port
}

/** Stands in for the project's API: echoes what reached it, and its WebSocket echoes too. */
function startApi(port: number) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request, server) {
      if (server.upgrade(request)) return undefined
      const url = new URL(request.url)
      return Response.json({
        path: `${url.pathname}${url.search}`,
        method: request.method,
        key: request.headers.get(BRANCH_KEY_HEADER),
      })
    },
    websocket: {
      message(ws, message) {
        ws.send(`echo:${message}`)
      },
    },
  })
}

describe("a branch runtime's front", () => {
  const stops: (() => unknown)[] = []
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop()
  })

  function start() {
    const port = freePort()
    const apiPort = freePort()
    const api = startApi(apiPort)
    const front = startBranchFront({
      branch: "vendor-invoices",
      key: KEY,
      host: "127.0.0.1",
      port,
      apiPort,
      root: tmpdir(),
    })
    stops.push(() => api.stop(true), front.stop)
    const url = `http://127.0.0.1:${port}`
    const get = (path: string, key: string | null = KEY) =>
      fetch(`${url}${path}`, { headers: key === null ? {} : { [BRANCH_KEY_HEADER]: key } })
    const status = async () => (await (await get(BRANCH_STATUS_PATH)).json()) as BranchRuntimeStatus
    return { front, url, port, get, status }
  }

  test("answers only requests that carry the branch's key", async () => {
    const { get } = start()
    expect((await get(BRANCH_STATUS_PATH, null)).status).toBe(401)
    expect((await get(BRANCH_STATUS_PATH, `${"k".repeat(39)}x`)).status).toBe(401)
    expect((await get(BRANCH_STATUS_PATH)).status).toBe(200)
  })

  test("forwards to the API once the generation is ready, and answers with its status until then", async () => {
    const { front, get, status } = start()
    front.reporter.starting?.()
    const waiting = await get("/api/objects?limit=1")
    expect(waiting.status).toBe(503)
    expect(((await waiting.json()) as BranchRuntimeStatus).state).toBe("starting")

    front.reporter.message({ type: "ready", watchesApp: false, app: null, manifest: "m1" }, 1)
    expect(await status()).toMatchObject({ generation: 1, state: "ready", manifest: "m1" })
    const forwarded = await get("/api/objects?limit=1")
    expect(await forwarded.json()).toEqual({
      path: "/api/objects?limit=1",
      method: "GET",
      key: null,
    })
  })

  test("names the file a failed generation points at, and clears it on the next", async () => {
    const { front, status } = start()
    front.reporter.starting?.()
    front.reporter.message(
      {
        type: "startup-error",
        error: { message: "Vendr is not defined", file: "ontology/vendor.ts" },
      },
      1
    )
    expect(await status()).toMatchObject({
      generation: 1,
      state: "failed",
      manifest: null,
      error: { message: "Vendr is not defined", file: "ontology/vendor.ts" },
    })

    front.reporter.starting?.()
    expect(await status()).toMatchObject({ generation: 2, state: "starting", error: null })
    front.reporter.message({ type: "ready", watchesApp: false, app: null, manifest: "m2" }, 2)
    front.reporter.exited(1)
    expect(await status()).toMatchObject({
      state: "failed",
      error: { message: expect.stringContaining("exit 1") },
    })
  })

  test("forwards a WebSocket both ways", async () => {
    const { front, port } = start()
    front.reporter.starting?.()
    front.reporter.message({ type: "ready", watchesApp: false, app: null }, 1)

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, {
      headers: { [BRANCH_KEY_HEADER]: KEY },
    } as never)
    const reply = await new Promise<string>((resolve, reject) => {
      socket.onopen = () => socket.send("hello")
      socket.onmessage = (event) => resolve(String(event.data))
      socket.onerror = () => reject(new Error("socket failed"))
    })
    socket.close()
    expect(reply).toBe("echo:hello")
  })
})

describe("the file a startup error points at", () => {
  const root = "/work/acme"

  test("is the first frame inside the project, found through the error's causes", () => {
    const cause = new Error("Vendr is not defined")
    cause.stack = [
      "ReferenceError: Vendr is not defined",
      `    at ${root}/node_modules/@sixb/core/dist/index.js:10:2`,
      `    at <anonymous> (${join(root, "ontology/vendor.ts")}:4:7)`,
    ].join("\n")
    const error = new Error("Failed to load ontology module 'ontology/vendor.ts'", { cause })
    error.stack = `Error: Failed to load\n    at load (/elsewhere/core/discovery.ts:340:13)`

    expect(projectFileOf(error, root)).toBe("ontology/vendor.ts")
  })

  test("is nothing when no frame is in the project", () => {
    const error = new Error("boom")
    error.stack = "Error: boom\n    at x (/elsewhere/a.ts:1:1)"
    expect(projectFileOf(error, root)).toBeUndefined()
  })
})
