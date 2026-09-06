import { expect, test } from "bun:test"
import {
  agentSurfaceSessionStorageKey,
  clampAgentSurfaceWidth,
  handoffAgentSurfaceThread,
  parseAgentSurfaceSessionState,
  setAgentSurfaceMode,
} from "../src/agent-surface-state"

const defaults = {
  mode: "dock",
  dockWidth: 384,
  threadId: null,
} as const

test("agent surface state restores the tab's mode, width, and selected thread", () => {
  expect(
    parseAgentSurfaceSessionState(
      JSON.stringify({ mode: "collapsed", dockWidth: 512, threadId: "thread-42" }),
      defaults
    )
  ).toEqual({
    mode: "collapsed",
    dockWidth: 512,
    threadId: "thread-42",
  })
})

test("agent surface state rejects malformed values and clamps persisted widths", () => {
  expect(parseAgentSurfaceSessionState("not json", defaults)).toEqual(defaults)
  expect(
    parseAgentSurfaceSessionState(
      JSON.stringify({ mode: "unknown", dockWidth: 2_000, threadId: "" }),
      defaults
    )
  ).toEqual({
    mode: "dock",
    dockWidth: 720,
    threadId: null,
  })
  expect(clampAgentSurfaceWidth(401.8, 320, 720)).toBe(402)
})

test("agent surface state uses a stable per-agent session key and can disable persistence", () => {
  expect(agentSurfaceSessionStorageKey("operations-assistant")).toBe(
    "sixb.agent-ui.surface.v1:operations-assistant"
  )
  expect(agentSurfaceSessionStorageKey("operations-assistant", "custom-surface")).toBe(
    "custom-surface"
  )
  expect(agentSurfaceSessionStorageKey("operations-assistant", false)).toBeNull()
})

test("a landing panel can hand its durable thread to the tab's dock", () => {
  const values = new Map<string, string>()
  const events: Event[] = []
  const sessionStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  }
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      sessionStorage,
      dispatchEvent: (event: Event) => {
        events.push(event)
        return true
      },
    },
  })

  try {
    values.set(
      agentSurfaceSessionStorageKey("operations-assistant") ?? "",
      JSON.stringify({ mode: "collapsed", dockWidth: 512, threadId: "old-thread" })
    )
    handoffAgentSurfaceThread("operations-assistant", "home-thread")

    expect(
      JSON.parse(values.get("sixb.agent-ui.surface.v1:operations-assistant") ?? "null")
    ).toEqual({ mode: "dock", dockWidth: 512, threadId: "home-thread" })
    expect(events).toHaveLength(1)
    expect((events[0] as CustomEvent).detail).toEqual({
      agentId: "operations-assistant",
      storageKey: "sixb.agent-ui.surface.v1:operations-assistant",
      state: { mode: "dock", dockWidth: 512, threadId: "home-thread" },
    })
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow)
    } else {
      Reflect.deleteProperty(globalThis, "window")
    }
  }
})

test("a host can collapse the dock without discarding its thread or width", () => {
  const values = new Map<string, string>()
  const events: Event[] = []
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
      dispatchEvent: (event: Event) => {
        events.push(event)
        return true
      },
    },
  })

  try {
    values.set(
      "sixb.agent-ui.surface.v1:operations-assistant",
      JSON.stringify({ mode: "dock", dockWidth: 544, threadId: "thread-42" })
    )
    setAgentSurfaceMode("operations-assistant", "collapsed")

    expect(
      JSON.parse(values.get("sixb.agent-ui.surface.v1:operations-assistant") ?? "null")
    ).toEqual({ mode: "collapsed", dockWidth: 544, threadId: "thread-42" })
    expect((events[0] as CustomEvent).detail.state).toEqual({
      mode: "collapsed",
      dockWidth: 544,
      threadId: "thread-42",
    })
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow)
    } else {
      Reflect.deleteProperty(globalThis, "window")
    }
  }
})
