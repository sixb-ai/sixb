import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import type { ArtifactLiveServerMessage } from "@sixb/core/artifacts/live"
import { type ArtifactLiveSocket, createArtifactLiveSocket } from "../src/artifact-live"

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readonly sent: string[] = []
  readyState = 0
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
    this.readyState = 3
    this.onclose?.()
  }

  /** The server accepts the connection and says it is ready. */
  accept(): void {
    this.readyState = 1
    this.onopen?.()
    this.onmessage?.({ data: JSON.stringify({ type: "connected", channel: "artifacts" }) })
  }
}

const latest = () => {
  const socket = FakeWebSocket.instances.at(-1)
  if (!socket) throw new Error("Expected a websocket.")
  return socket
}

describe("the live artifacts socket", () => {
  let original: typeof WebSocket
  let socket: ArtifactLiveSocket | null

  beforeEach(() => {
    original = globalThis.WebSocket
    socket = null
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    jest.useFakeTimers()
  })

  afterEach(() => {
    socket?.close()
    globalThis.WebSocket = original
    jest.useRealTimers()
  })

  test("says when the server takes joins, sends on the open connection, and hands messages on", () => {
    const connected: number[] = []
    const received: ArtifactLiveServerMessage[] = []
    socket = createArtifactLiveSocket({
      onConnected: () => connected.push(FakeWebSocket.instances.length),
      onMessage: (message) => received.push(message),
    })
    expect(latest().url).toEndWith("/ws/artifacts")
    // Nothing goes out before the connection is open.
    expect(socket.send({ type: "join", artifactId: "art_1" })).toBe(false)

    latest().accept()
    expect(connected).toEqual([1])
    expect(socket.send({ type: "join", artifactId: "art_1" })).toBe(true)
    expect(latest().sent.map((data) => JSON.parse(data))).toEqual([
      { type: "join", artifactId: "art_1" },
    ])

    latest().onmessage?.({
      data: JSON.stringify({ type: "access", artifactId: "art_1", access: "watch" }),
    })
    latest().onmessage?.({ data: "not json" })
    latest().onmessage?.({ data: JSON.stringify({ type: "subscribed" }) })
    expect(received).toEqual([{ type: "access", artifactId: "art_1", access: "watch" }])
  })

  test("reconnects with a wait that doubles until a connection is ready again", () => {
    // Reproduce by dropping maxReconnectDelayMs from createArtifactLiveSocket: every reconnect
    // waits the first delay, and a server that is down is asked twice a second.
    const connected: number[] = []
    socket = createArtifactLiveSocket({
      onConnected: () => connected.push(FakeWebSocket.instances.length),
      onMessage: () => {},
    })
    latest().accept()

    latest().close()
    jest.advanceTimersByTime(499)
    expect(FakeWebSocket.instances).toHaveLength(1)
    jest.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(2)

    // The server is still down: the next wait is twice as long.
    latest().close()
    jest.advanceTimersByTime(999)
    expect(FakeWebSocket.instances).toHaveLength(2)
    jest.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(3)

    // Back up: the next drop waits the first delay again, and joins are asked for anew.
    latest().accept()
    expect(connected).toEqual([1, 3])
    latest().close()
    jest.advanceTimersByTime(500)
    expect(FakeWebSocket.instances).toHaveLength(4)
  })
})
