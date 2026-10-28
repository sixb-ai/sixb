import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test"
import { client } from "@sixb/client"
import { readRunSound, watchRun, writeRunSound } from "../src/agent/run-sounds"
import { installDom } from "./helpers/dom"

installDom(["document", "HTMLElement", "localStorage"])
const originalConfig = client.getConfig()
client.setConfig({ baseUrl: "https://api.sixb.test" })

/** Sockets the watcher opens; a test plays the server by calling their handlers. */
const sockets: FakeSocket[] = []

class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = FakeSocket.CONNECTING
  readonly sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { readonly data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  constructor() {
    sockets.push(this)
  }

  send(message: string): void {
    this.sent.push(message)
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED
  }

  addEventListener(): void {}

  removeEventListener(): void {}
}

/** Every note played, by frequency: the speaker. */
const notes: number[] = []

class FakeAudioContext {
  readonly state = "running"
  readonly currentTime = 0
  readonly destination = {}

  createOscillator() {
    let frequency = 0
    return {
      frequency: {
        setValueAtTime: (value: number) => {
          frequency = value
        },
        exponentialRampToValueAtTime: () => {},
      },
      connect: (node: unknown) => node,
      start: () => notes.push(frequency),
      stop: () => {},
    }
  }

  createGain() {
    const ramp = () => {}
    return {
      gain: {
        setValueAtTime: ramp,
        linearRampToValueAtTime: ramp,
        exponentialRampToValueAtTime: ramp,
      },
      connect: (node: unknown) => node,
    }
  }
}

const previous = {
  WebSocket: Object.getOwnPropertyDescriptor(globalThis, "WebSocket"),
  AudioContext: Object.getOwnPropertyDescriptor(globalThis, "AudioContext"),
}

beforeAll(() => {
  for (const [key, value] of [
    ["WebSocket", FakeSocket],
    ["AudioContext", FakeAudioContext],
  ] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
})

afterEach(() => {
  mock.restore()
  sockets.length = 0
  notes.length = 0
  localStorage.clear()
  document.body.replaceChildren()
})

afterAll(() => {
  client.setConfig({ baseUrl: originalConfig.baseUrl })
  for (const [key, descriptor] of Object.entries(previous)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

const at = "2026-10-28T12:00:00.000Z"

/** The server says the run ended. */
function finish(socket: FakeSocket, runId: string, ended: Record<string, unknown>) {
  socket.onopen?.()
  socket.onmessage?.({
    data: JSON.stringify({
      type: "record",
      record: {
        streamId: `agents.runs.${runId}`,
        cursor: "c1",
        publishedAt: at,
        payload: {
          schemaVersion: 1,
          projectId: "proj",
          runId,
          threadId: "thread",
          attempt: 1,
          occurredAt: at,
          type: "agent.run.finished",
          ...ended,
        },
      },
    }),
  })
}

function socketFor(runId: string): FakeSocket {
  const socket = sockets.at(-1)
  if (!socket) throw new Error(`Expected a socket for ${runId}.`)
  return socket
}

/** The conversation's transcript on screen, as the transcript tags it, hit where it shows. */
function showConversation(threadId: string) {
  const transcript = document.createElement("div")
  transcript.dataset.agentThread = threadId
  const message = document.createElement("p")
  transcript.append(message)
  document.body.append(transcript)
  return spyOn(document, "elementFromPoint").mockReturnValue(message)
}

const DONE = [659.25, 987.77]
const WAITING = [880, 880]

describe("a sound when the agent's turn ends", () => {
  // Removal proof: drop the tone from watchRun's end, and the reader hears nothing.
  test("plays when a turn ends while you are away from it", () => {
    spyOn(document, "hasFocus").mockReturnValue(true)
    watchRun({ id: "run_away", threadId: "thread" })
    finish(socketFor("run_away"), "run_away", { status: "succeeded", finishReason: "stop" })

    expect(notes).toEqual(DONE)
    expect(socketFor("run_away").readyState).toBe(FakeSocket.CLOSED)
  })

  // Removal proof: drop `!watching(...)` from the condition, and the first turn plays too.
  test("stays quiet for a turn you watch end, but not once you look elsewhere", () => {
    const focus = spyOn(document, "hasFocus").mockReturnValue(true)
    const hit = showConversation("thread")
    watchRun({ id: "run_watched", threadId: "thread" })
    finish(socketFor("run_watched"), "run_watched", { status: "succeeded" })
    expect(notes).toEqual([])

    // The same conversation on screen, in a window that lost focus.
    focus.mockReturnValue(false)
    watchRun({ id: "run_unfocused", threadId: "thread" })
    finish(socketFor("run_unfocused"), "run_unfocused", { status: "succeeded" })
    expect(notes).toEqual(DONE)

    // Another conversation on screen.
    notes.length = 0
    focus.mockReturnValue(true)
    hit.mockRestore()
    showConversation("another-thread")
    watchRun({ id: "run_elsewhere", threadId: "thread" })
    finish(socketFor("run_elsewhere"), "run_elsewhere", { status: "succeeded" })
    expect(notes).toEqual(DONE)
  })

  test("says a call waits for you, and nothing for a turn someone stopped", () => {
    spyOn(document, "hasFocus").mockReturnValue(false)
    watchRun({ id: "run_held", threadId: "thread" })
    finish(socketFor("run_held"), "run_held", {
      status: "succeeded",
      finishReason: "awaiting_approval",
    })
    expect(notes).toEqual(WAITING)

    notes.length = 0
    watchRun({ id: "run_stopped", threadId: "thread" })
    finish(socketFor("run_stopped"), "run_stopped", { status: "cancelled" })
    expect(notes).toEqual([])

    notes.length = 0
    watchRun({ id: "run_failed", threadId: "thread" })
    finish(socketFor("run_failed"), "run_failed", { status: "failed" })
    expect(notes).toEqual(DONE)
  })

  // Removal proofs: drop onRunSnapshot, and nothing plays until the replayed event. Drop the
  // close() from end, and the replayed event plays a second time.
  test("plays once for a run that ended before its socket subscribed", () => {
    spyOn(document, "hasFocus").mockReturnValue(false)
    watchRun({ id: "run_quick", threadId: "thread" })
    const socket = socketFor("run_quick")
    socket.onopen?.()
    socket.onmessage?.({
      data: JSON.stringify({
        type: "run.snapshot",
        run: {
          id: "run_quick",
          projectId: "proj",
          kind: "conversation",
          threadId: "thread",
          triggerMessageId: "message",
          status: "succeeded",
          attempt: 1,
          streamId: "agents.runs.run_quick",
          createdAt: at,
          updatedAt: at,
        },
      }),
    })
    expect(notes).toEqual(DONE)

    finish(socket, "run_quick", { status: "succeeded" })
    expect(notes).toEqual(DONE)
  })

  // Removal proof: play "chime" whatever was chosen, and the bell is never heard.
  test("plays the sound you chose", () => {
    spyOn(document, "hasFocus").mockReturnValue(false)
    writeRunSound("bell")
    watchRun({ id: "run_bell", threadId: "thread" })
    finish(socketFor("run_bell"), "run_bell", { status: "succeeded" })

    // A struck C6 and its two overtones.
    expect(notes).toEqual([1046.5, 2093, 3139.5])
  })

  // Removal proof: drop the "off" check from watchRun, and a socket opens.
  test("turned off in this browser, follows no run", () => {
    expect(readRunSound()).toBe("chime")
    writeRunSound("off")
    expect(readRunSound()).toBe("off")

    watchRun({ id: "run_off", threadId: "thread" })
    expect(sockets).toEqual([])
  })

  test("a choice it does not know reads as the chime", () => {
    localStorage.setItem("sixb:agent-sounds", "trumpet")
    expect(readRunSound()).toBe("chime")
  })
})
