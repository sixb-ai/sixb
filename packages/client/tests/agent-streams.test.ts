import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { AGENT_RUN_STREAM_SCHEMA_VERSION } from "@sixb/core/agents/streams"
import { createAgentRunSocket, type SixbFailure } from "../src/agent-streams"

function runSnapshotFrame(): string {
  return JSON.stringify({
    type: "run.snapshot",
    run: {
      id: "run-1",
      projectId: "proj",
      threadId: "thr-1",
      agentId: "assistant",
      triggerMessageId: "msg-1",
      requestedByPrincipal: { type: "user", id: "usr-1" },
      status: "queued",
      attempt: 0,
      streamId: "agents.runs.run-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  })
}

function agentRecordFrame(cursor: string): string {
  return JSON.stringify({
    type: "record",
    record: {
      streamId: "agent-run:run-1",
      cursor,
      name: "agent.run.started",
      key: "run-1",
      publishedAt: "2026-01-01T00:00:00.000Z",
      payload: {
        schemaVersion: AGENT_RUN_STREAM_SCHEMA_VERSION,
        type: "agent.run.started",
        projectId: "proj",
        runId: "run-1",
        threadId: "thr-1",
        agentId: "assistant",
        attempt: 1,
        occurredAt: "2026-01-01T00:00:00.000Z",
      },
    },
  })
}

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

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

describe("createAgentRunSocket", () => {
  let originalWebSocket: typeof WebSocket

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket
  })

  test("subscribes to the run, delivers records with their cursor, and resumes on reconnect", async () => {
    const received: Array<{ type: string; cursor: string }> = []
    const snapshots: string[] = []
    const socket = createAgentRunSocket({
      runId: "run-1",
      reconnect: true,
      reconnectDelayMs: 1,
      onEvent: (event, cursor) => received.push({ type: event.type, cursor }),
      onRunSnapshot: (run) => snapshots.push(run.status),
    })

    const ws1 = FakeWebSocket.instances[0]
    if (!ws1) throw new Error("expected a websocket")
    expect(ws1.url).toContain("/ws/agents")
    ws1.onopen?.()
    const firstSubscribe = JSON.parse(ws1.sent[0])
    expect(firstSubscribe).toEqual({ type: "subscribe", runId: "run-1" })
    expect(firstSubscribe.afterCursor).toBeUndefined()

    ws1.onmessage?.({ data: runSnapshotFrame() })
    ws1.onmessage?.({ data: agentRecordFrame("c5") })
    expect(snapshots).toEqual(["queued"])
    expect(received).toEqual([{ type: "agent.run.started", cursor: "c5" }])

    // Connection drops; the socket reconnects and resumes after the last delivered cursor.
    ws1.onclose?.()
    await tick()

    const ws2 = FakeWebSocket.instances[1]
    if (!ws2) throw new Error("expected a reconnect")
    ws2.onopen?.()
    expect(JSON.parse(ws2.sent[0]).afterCursor).toBe("c5")

    socket.close()
  })

  // The server has put a code on its error frames and the parser reads it; these two lock the rest
  // of the trip. Before that, `onError` took a `string` and this test asserted a message alone — so
  // it passed while the code was dropped one line after being parsed.
  test("surfaces the server's failure code through onError", async () => {
    const failures: SixbFailure[] = []
    const socket = createAgentRunSocket({
      runId: "run-1",
      reconnect: false,
      onEvent: () => {},
      onError: (failure) => failures.push(failure),
    })

    const ws1 = FakeWebSocket.instances[0]
    if (!ws1) throw new Error("expected a websocket")
    ws1.onopen?.()
    ws1.onmessage?.({
      data: JSON.stringify({ type: "error", code: "agent.run_not_found", message: "run gone" }),
    })
    expect(failures).toEqual([{ code: "agent.run_not_found", message: "run gone" }])

    socket.close()
  })

  test("files a frame with no code under runtime.unexpected", async () => {
    const failures: SixbFailure[] = []
    const socket = createAgentRunSocket({
      runId: "run-1",
      reconnect: false,
      onEvent: () => {},
      onError: (failure) => failures.push(failure),
    })

    const ws1 = FakeWebSocket.instances[0]
    if (!ws1) throw new Error("expected a websocket")
    ws1.onopen?.()
    ws1.onmessage?.({ data: JSON.stringify({ type: "error", message: "run gone" }) })
    expect(failures).toEqual([{ code: "runtime.unexpected", message: "run gone" }])

    socket.close()
  })

  test("does not reconnect once closed", async () => {
    const socket = createAgentRunSocket({
      runId: "run-1",
      reconnect: true,
      reconnectDelayMs: 1,
      onEvent: () => {},
    })

    const ws1 = FakeWebSocket.instances[0]
    if (!ws1) throw new Error("expected a websocket")
    ws1.onopen?.()
    socket.close()
    ws1.onclose?.()
    await tick()

    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
