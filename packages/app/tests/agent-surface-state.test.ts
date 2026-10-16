import { expect, test } from "bun:test"
import {
  agentSurfaceSessionStorageKey,
  clampAgentSurfaceWidth,
  parseAgentSurfaceSessionState,
  setAgentSurfaceMode,
} from "../src/agent/agent-surface-state"

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

test("agent surface state uses a stable session key and can disable persistence", () => {
  expect(agentSurfaceSessionStorageKey()).toBe("sixb.agent-ui.surface.v1:agents")
  expect(agentSurfaceSessionStorageKey("custom-surface")).toBe("custom-surface")
  expect(agentSurfaceSessionStorageKey(false)).toBeNull()
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
      "sixb.agent-ui.surface.v1:agents",
      JSON.stringify({ mode: "dock", dockWidth: 544, threadId: "thread-42" })
    )
    setAgentSurfaceMode("collapsed")

    expect(JSON.parse(values.get("sixb.agent-ui.surface.v1:agents") ?? "null")).toEqual({
      mode: "collapsed",
      dockWidth: 544,
      threadId: "thread-42",
    })
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
