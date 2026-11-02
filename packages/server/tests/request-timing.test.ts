import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import {
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  SixbHost,
} from "@sixb/core"
import {
  createStorageOperationScope,
  runWithStorageTimer,
  StorageTimer,
} from "@sixb/core/internal/storage-operation-scope"
import { SixbServer } from "../src/server"
import {
  markRequestAuthorized,
  noteRequestSubject,
  requestTimingOptionsFromEnv,
  timeRequest,
} from "../src/utils/request-timing"
import { createTestBrowserPolicy, getFreePort } from "./helpers"

const request = () =>
  new Request("https://api.example.com/api/objects/query?q=someone@example.com", {
    method: "POST",
    headers: { origin: "https://app.example.com" },
  })
const scope = createStorageOperationScope(async (run) => run())
const wait = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis))

let warn: ReturnType<typeof spyOn>
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => undefined)
})
afterEach(() => warn.mockRestore())

function metrics(response: Response) {
  const header = response.headers.get("server-timing") ?? ""
  return Object.fromEntries(
    header.split(", ").map((metric) => {
      const [name, duration] = metric.split(";")
      return [name, Number(duration?.replace("dur=", ""))]
    })
  )
}

test("a signed-in request is told where its time went, and storage counts apart from auth", async () => {
  const response = (await timeRequest(request(), { header: true }, async () => {
    await scope.run(() => wait(5))
    markRequestAuthorized("/api/objects/query", true)
    await scope.run(() => wait(20))
    await wait(10)
    return new Response("{}", { status: 201, headers: { etag: "kept" } })
  })) as Response

  const { auth, storage, app, total } = metrics(response)
  expect(response.headers.get("server-timing")).toContain("storage;dur=")
  expect(response.headers.get("server-timing")).toContain('desc="1 call"')
  expect(auth).toBeGreaterThanOrEqual(4)
  expect(storage).toBeGreaterThanOrEqual(18)
  expect(storage).toBeLessThan(total as number)
  expect(app).toBeGreaterThanOrEqual(8)
  expect(response.headers.get("timing-allow-origin")).toBe("https://app.example.com")

  expect(response.status).toBe(201)
  expect(response.headers.get("etag")).toBe("kept")
  expect(await response.text()).toBe("{}")
})

test("overlapping storage calls count once, and an inner call is part of its outer one", async () => {
  const timer = new StorageTimer()
  await runWithStorageTimer(timer, () =>
    Promise.all([
      scope.run(() => wait(30)),
      scope.run(async () => {
        await scope.run(() => wait(5))
        await wait(25)
      }),
    ])
  )
  expect(timer.calls).toBe(2)
  expect(timer.busyMillis).toBeGreaterThanOrEqual(25)
  expect(timer.busyMillis).toBeLessThan(55)
})

test("nobody receives timings unless the server sends them and the caller signed in", async () => {
  const respond = (showTimings: boolean) => () => {
    markRequestAuthorized("/api/objects/query", showTimings)
    return new Response("{}")
  }
  const off = (await timeRequest(request(), {}, respond(true))) as Response
  const anonymous = (await timeRequest(request(), { header: true }, respond(false))) as Response
  const publicRoute = (await timeRequest(
    request(),
    { header: true },
    () => new Response()
  )) as Response

  for (const response of [off, anonymous, publicRoute]) {
    expect(response.headers.has("server-timing")).toBe(false)
    expect(response.headers.has("timing-allow-origin")).toBe(false)
  }
})

test("a slow request is logged by its route and type, without its URL or values", async () => {
  await timeRequest(request(), { slowRequestMillis: 10 }, async () => {
    markRequestAuthorized("/api/objects/query", true)
    noteRequestSubject("Timecard")
    await scope.run(() => wait(15))
    return new Response("{}")
  })

  expect(warn).toHaveBeenCalledTimes(1)
  const line = String(warn.mock.calls[0]?.[0])
  expect(line).toContain("POST /api/objects/query (Timecard) 200 in")
  expect(line).toContain("in 1 call,")
  expect(line).not.toContain("someone@example.com")
})

test("the log can be turned off, and a quick request is not logged", async () => {
  const slow = async () => {
    await wait(5)
    return new Response()
  }
  await timeRequest(request(), { slowRequestMillis: 0 }, slow)
  await timeRequest(request(), {}, slow)
  expect(warn).not.toHaveBeenCalled()
})

test("a WebSocket upgrade passes through untouched", async () => {
  expect(await timeRequest(request(), { header: true }, () => undefined)).toBeUndefined()
})

test("settings come from the environment", () => {
  expect(requestTimingOptionsFromEnv({})).toEqual({ header: false })
  expect(requestTimingOptionsFromEnv({ SIXB_SERVER_TIMING: "1" }).header).toBe(true)
  expect(requestTimingOptionsFromEnv({ SIXB_SLOW_REQUEST_MS: "250" }).slowRequestMillis).toBe(250)
  expect(requestTimingOptionsFromEnv({ SIXB_SLOW_REQUEST_MS: "0" }).slowRequestMillis).toBe(0)
  expect(requestTimingOptionsFromEnv({ SIXB_SLOW_REQUEST_MS: "soon" })).toEqual({ header: false })
})

test("a query through the real server reports its route, type and storage time", async () => {
  const Device = defineObjectType({
    id: "device",
    name: "Device",
    properties: [prop("id", "string", { required: true, primary: true })],
  })
  const host = new SixbHost({
    id: "test-project",
    ontology: [Device],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
  const port = await getFreePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const server = new SixbServer({
    host,
    hostname: "127.0.0.1",
    port,
    quiet: true,
    browser: createTestBrowserPolicy({ apiOrigin: baseUrl }),
    timing: { header: true, slowRequestMillis: 0.001 },
  })
  await server.start()
  try {
    const response = await fetch(`${baseUrl}/api/objects/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: { kind: "limit", limit: 5, input: { kind: "start", objectTypeId: "device" } },
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ objects: [] })
    const header = response.headers.get("server-timing")
    expect(header).toMatch(
      /auth;dur=[\d.]+, storage;dur=[\d.]+;desc="\d+ calls?", app;dur=[\d.]+, total;dur=/
    )
    expect(header).not.toContain('desc="0 calls"')
    const logged = warn.mock.calls.map((call: unknown[]) => String(call[0]))
    expect(
      logged.some((line: string) => line.includes("POST /api/objects/query (device) 200 in"))
    ).toBe(true)
  } finally {
    await server.stop()
  }
})
