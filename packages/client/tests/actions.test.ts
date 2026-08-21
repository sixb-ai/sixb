import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  type ActionRunDetail,
  ActionRunFailedError,
  ActionRunTimeoutError,
  createSixbClient,
  requestActionAndWait,
  waitForActionRun,
} from "../src"
import type { SixbEvent } from "../src/events"

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readonly sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.onclose?.()
  }
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(predicate: () => boolean, timeoutMs = 200): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.")
    }
    await tick(1)
  }
}

function createActionRun(overrides: Partial<ActionRunDetail> = {}): ActionRunDetail {
  return {
    id: "act_1",
    projectId: "proj",
    actionId: "approveQuote",
    subject: { kind: "object", objectTypeId: "Quote", primaryId: "q_123" },
    status: "queued",
    queuedAt: "2026-06-29T12:00:00.000Z",
    params: {},
    ...overrides,
  }
}

type ActionRunFailure = NonNullable<ActionRunDetail["error"]>

function actionFailure(
  phase: ActionRunFailure["details"]["phase"],
  message: string
): ActionRunFailure {
  return {
    code: phase === "cancelled" ? "runtime.cancelled" : "action.phase_failed",
    message,
    retryable: false,
    at: "2026-06-29T12:00:02.000Z",
    details: { actionId: "approveQuote", runId: "act_1", phase },
  }
}

function actionEvent(type: "action.completed" | "action.failed", runId = "act_1"): SixbEvent {
  return {
    id: `evt_${type}`,
    cursor: `cur_${type}`,
    projectId: "proj",
    occurredAt: "2026-06-29T12:00:02.000Z",
    type,
    topic: "actions",
    partitionKey: runId,
    payload:
      type === "action.completed"
        ? {
            actionId: "approveQuote",
            runId,
            subject: { kind: "object", objectTypeId: "Quote", primaryId: "q_123" },
            finishedAt: "2026-06-29T12:00:02.000Z",
          }
        : {
            actionId: "approveQuote",
            runId,
            subject: { kind: "object", objectTypeId: "Quote", primaryId: "q_123" },
            error: actionFailure("writeback", "Action failed"),
            finishedAt: "2026-06-29T12:00:02.000Z",
          },
  } as SixbEvent
}

function createTestClient(handler: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = []
  const fetchMock = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = input instanceof Request && !init ? input : new Request(input, init)
      requests.push(request)
      return handler(request)
    },
    { preconnect: fetch.preconnect }
  ) satisfies typeof fetch

  return {
    client: createSixbClient({ baseUrl: "http://sixb.test", fetch: fetchMock }),
    requests,
  }
}

describe("action wait helpers", () => {
  let originalWebSocket: typeof WebSocket

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket
  })

  test("requests an action, waits for the terminal event, and returns final detail", async () => {
    let getCount = 0
    let requested = false
    const succeeded = createActionRun({
      status: "succeeded",
      phase: "effects",
      startedAt: "2026-06-29T12:00:01.000Z",
      finishedAt: "2026-06-29T12:00:02.000Z",
    })
    const { client, requests } = createTestClient(async (request) => {
      const url = new URL(request.url)
      if (request.method === "POST" && url.pathname === "/api/actions/approveQuote") {
        const body = await request.json()
        expect(body).toMatchObject({ params: { note: "Approved" } })
        return Response.json(
          {
            runId: "act_1",
            queuedAt: "2026-06-29T12:00:00.000Z",
            created: true,
          },
          { status: 202 }
        )
      }
      if (request.method === "GET" && url.pathname === "/api/action-runs/act_1") {
        getCount += 1
        return Response.json(getCount === 1 ? createActionRun() : succeeded)
      }
      return Response.json({ error: "Unexpected request" }, { status: 500 })
    })

    const promise = requestActionAndWait({
      client,
      path: { actionId: "approveQuote" },
      body: {
        subject: { kind: "object", objectTypeId: "Quote", primaryId: "q_123" },
        params: { note: "Approved" },
      },
      fallbackPollIntervalMs: 500,
      timeoutMs: 1_000,
      onRequested: (response) => {
        requested = response.runId === "act_1"
      },
    })

    await waitUntil(() => getCount === 1)
    const ws = FakeWebSocket.instances[0]
    if (!ws) throw new Error("expected a websocket")
    ws.onopen?.()
    ws.onmessage?.({ data: JSON.stringify({ type: "connected" }) })
    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
      type: "subscribe",
      topic: "actions",
      types: ["action.completed", "action.failed"],
      runId: "act_1",
    })

    ws.onmessage?.({
      data: JSON.stringify({ type: "event", event: actionEvent("action.completed") }),
    })
    const run = await promise

    expect(requested).toBe(true)
    expect(run).toEqual(succeeded)
    expect(getCount).toBe(2)
    expect(ws.closed).toBe(true)
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      ["POST /api/actions/approveQuote", "GET /api/action-runs/act_1", "GET /api/action-runs/act_1"]
    )
  })

  test("uses slow fallback polling when the socket is healthy but no terminal event arrives", async () => {
    let getCount = 0
    const { client } = createTestClient((request) => {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/api/action-runs/act_1") {
        getCount += 1
        return Response.json(
          getCount < 3
            ? createActionRun({ status: "running" })
            : createActionRun({ status: "succeeded", finishedAt: "2026-06-29T12:00:02.000Z" })
        )
      }
      return Response.json({ error: "Unexpected request" }, { status: 500 })
    })

    const promise = waitForActionRun({
      client,
      runId: "act_1",
      fallbackPollIntervalMs: 5,
      disconnectedPollIntervalMs: 500,
      timeoutMs: 200,
    })

    await waitUntil(() => getCount === 1)
    const ws = FakeWebSocket.instances[0]
    if (!ws) throw new Error("expected a websocket")
    ws.onopen?.()
    ws.onmessage?.({ data: JSON.stringify({ type: "connected" }) })
    ws.onmessage?.({ data: JSON.stringify({ type: "subscribed" }) })

    const run = await promise

    expect(ws.closed).toBe(true)
    expect(run.status).toBe("succeeded")
    expect(getCount).toBe(3)
  })

  test("rechecks when a fast action completes before its subscription is ready", async () => {
    let getCount = 0
    let completed = false
    const succeeded = createActionRun({
      status: "succeeded",
      finishedAt: "2026-06-29T12:00:02.000Z",
    })
    const { client } = createTestClient((request) => {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/api/action-runs/act_1") {
        getCount += 1
        return Response.json(completed ? succeeded : createActionRun({ status: "running" }))
      }
      return Response.json({ error: "Unexpected request" }, { status: 500 })
    })

    const promise = waitForActionRun({
      client,
      runId: "act_1",
      fallbackPollIntervalMs: 1_000,
      disconnectedPollIntervalMs: 1_000,
      timeoutMs: 200,
    })

    await waitUntil(() => getCount === 1)
    completed = true

    const ws = FakeWebSocket.instances[0]
    if (!ws) throw new Error("expected a websocket")
    ws.onopen?.()
    ws.onmessage?.({ data: JSON.stringify({ type: "connected" }) })
    // The server's baseline already includes the terminal event, so no event
    // frame follows. Subscription acknowledgement must trigger the second read.
    ws.onmessage?.({ data: JSON.stringify({ type: "subscribed" }) })

    const run = await promise

    expect(run).toEqual(succeeded)
    expect(getCount).toBe(2)
    expect(ws.closed).toBe(true)
  })

  test("runs a follow-up detail fetch when a terminal event arrives during an in-flight check", async () => {
    let getCount = 0
    const firstGet = {
      resolve: undefined as ((response: Response) => void) | undefined,
    }
    const succeeded = createActionRun({
      status: "succeeded",
      finishedAt: "2026-06-29T12:00:02.000Z",
    })
    const { client } = createTestClient((request) => {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/api/action-runs/act_1") {
        getCount += 1
        if (getCount === 1) {
          return new Promise<Response>((resolve) => {
            firstGet.resolve = resolve
          })
        }
        return Response.json(succeeded)
      }
      return Response.json({ error: "Unexpected request" }, { status: 500 })
    })

    const promise = waitForActionRun({
      client,
      runId: "act_1",
      fallbackPollIntervalMs: 1_000,
      disconnectedPollIntervalMs: 1_000,
      timeoutMs: 500,
    })

    await waitUntil(() => getCount === 1 && firstGet.resolve !== undefined)
    const ws = FakeWebSocket.instances[0]
    if (!ws) throw new Error("expected a websocket")
    ws.onopen?.()
    ws.onmessage?.({ data: JSON.stringify({ type: "connected" }) })
    ws.onmessage?.({
      data: JSON.stringify({ type: "event", event: actionEvent("action.completed") }),
    })

    const resolve = firstGet.resolve
    if (!resolve) throw new Error("expected pending run detail request")
    resolve(Response.json(createActionRun({ status: "running" })))
    const run = await promise

    expect(run).toEqual(succeeded)
    expect(getCount).toBe(2)
  })

  test("uses faster fallback polling while the event socket is disconnected", async () => {
    let getCount = 0
    const { client } = createTestClient((request) => {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/api/action-runs/act_1") {
        getCount += 1
        return Response.json(
          getCount < 2
            ? createActionRun({ status: "running" })
            : createActionRun({ status: "succeeded", finishedAt: "2026-06-29T12:00:02.000Z" })
        )
      }
      return Response.json({ error: "Unexpected request" }, { status: 500 })
    })

    const run = await waitForActionRun({
      client,
      runId: "act_1",
      fallbackPollIntervalMs: 1_000,
      disconnectedPollIntervalMs: 5,
      timeoutMs: 200,
    })

    expect(run.status).toBe("succeeded")
    expect(getCount).toBe(2)
  })

  test("rejects when the terminal action run failed", async () => {
    const { client } = createTestClient((request) => {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/api/action-runs/act_1") {
        return Response.json(
          createActionRun({
            status: "failed",
            phase: "writeback",
            finishedAt: "2026-06-29T12:00:02.000Z",
            error: actionFailure("writeback", "Writeback failed"),
          })
        )
      }
      return Response.json({ error: "Unexpected request" }, { status: 500 })
    })

    let error: unknown
    try {
      await waitForActionRun({ client, runId: "act_1", timeoutMs: 200 })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(ActionRunFailedError)
    expect((error as ActionRunFailedError).runId).toBe("act_1")
    expect((error as ActionRunFailedError).status).toBe("failed")
    expect((error as ActionRunFailedError).message).toBe("Writeback failed")
  })

  test("rejects when the terminal action run was cancelled", async () => {
    const { client } = createTestClient((request) => {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/api/action-runs/act_1") {
        return Response.json(
          createActionRun({
            status: "cancelled",
            phase: "cancelled",
            finishedAt: "2026-06-29T12:00:02.000Z",
            error: actionFailure("cancelled", "Action was cancelled"),
          })
        )
      }
      return Response.json({ error: "Unexpected request" }, { status: 500 })
    })

    let error: unknown
    try {
      await waitForActionRun({ client, runId: "act_1", timeoutMs: 200 })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(ActionRunFailedError)
    expect((error as ActionRunFailedError).status).toBe("cancelled")
    expect((error as ActionRunFailedError).message).toBe("Action was cancelled")
  })

  test("can return failed terminal records when rejection is disabled", async () => {
    const failed = createActionRun({
      status: "failed",
      finishedAt: "2026-06-29T12:00:02.000Z",
      error: actionFailure("effects", "Handled manually"),
    })
    const { client } = createTestClient((request) => {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/api/action-runs/act_1") {
        return Response.json(failed)
      }
      return Response.json({ error: "Unexpected request" }, { status: 500 })
    })

    const run = await waitForActionRun({
      client,
      runId: "act_1",
      rejectOnTerminalFailure: false,
      timeoutMs: 200,
    })

    expect(run).toEqual(failed)
  })

  test("rejects when the wait times out", async () => {
    const { client } = createTestClient((request) => {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/api/action-runs/act_1") {
        return Response.json(createActionRun({ status: "running" }))
      }
      return Response.json({ error: "Unexpected request" }, { status: 500 })
    })

    let error: unknown
    try {
      await waitForActionRun({
        client,
        runId: "act_1",
        disconnectedPollIntervalMs: 5,
        timeoutMs: 15,
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(ActionRunTimeoutError)
    expect((error as ActionRunTimeoutError).runId).toBe("act_1")
  })
})
