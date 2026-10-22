/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from "bun:test"
import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import type { DevReadyView } from "../src/lib/dev-messages"
import { ansiToStyledText } from "../src/ui/live/ansi"
import { DevFooter, type DevState } from "../src/ui/live/dev"
import type { LiveColors } from "../src/ui/live/session"
import { palette } from "../src/ui/theme"

const colors: LiveColors = { ...palette, text: "#eceef2" }

const view: DevReadyView = {
  name: "northline",
  apiUrl: "http://localhost:3001/api",
  apiDocsUrl: "http://localhost:3001/docs",
  wsUrl: "ws://localhost:3001/ws/events",
  appUrl: "http://localhost:3000",
  workers: [
    { type: "agent", concurrency: 8 },
    { type: "sync", concurrency: 1 },
  ],
  warnings: [],
}

let setup: TestRendererSetup | null = null
afterEach(() => {
  setup?.renderer.destroy()
  setup = null
})

async function renderFooter(state: DevState) {
  const calls: string[] = []
  const store = { subscribe: () => () => {}, get: () => state }
  setup = await testRender(
    <DevFooter
      store={store}
      colors={colors}
      entry="sixb.config.ts"
      projectName="northline"
      controls={{ restart: () => calls.push("restart"), quit: () => calls.push("quit") }}
    />,
    { width: 100, height: 10 }
  )
  // The footer renders on its own clock, as it does in a terminal; React's act() checks do not
  // apply past the first mount.
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false })
  await setup.renderOnce()
  return { frame: setup.captureCharFrame(), calls, setup }
}

describe("sixb dev footer", () => {
  test("shows what a ready dev process serves, and the keys that act on it", async () => {
    const { frame } = await renderFooter({
      phase: { kind: "ready" },
      view,
      restarts: 2,
      readySince: Date.now(),
    })

    expect(frame).toContain("sixb dev  northline")
    expect(frame).toContain("● ready")
    expect(frame).toContain("2 restarts")
    expect(frame).toContain("app      http://localhost:3000")
    expect(frame).toContain("docs /docs")
    expect(frame).toContain("agent 8 · sync 1")
    expect(frame).toContain("o open app")
  })

  test("says why a start failed, without the keys that need a running app", async () => {
    const { frame } = await renderFooter({
      phase: {
        kind: "failed",
        error: {
          message: "[Sixb] Object type 'Customer' links to 'Acount'.",
          remediation: "Fix the link.",
        },
      },
      view: null,
      restarts: 0,
      readySince: null,
    })

    expect(frame).toContain("✕ failed")
    expect(frame).toContain("links to 'Acount'")
    expect(frame).toContain("Fix the link.")
    expect(frame).not.toContain("open app")
    expect(frame).toContain("r restart")
  })

  test("restarts on r and quits on q or ctrl+c", async () => {
    const { calls, setup } = await renderFooter({
      phase: { kind: "ready" },
      view,
      restarts: 0,
      readySince: Date.now(),
    })

    setup.mockInput.pressKey("r")
    setup.mockInput.pressKey("q")
    setup.mockInput.pressCtrlC()
    await setup.renderOnce()

    expect(calls).toEqual(["restart", "quit", "quit"])
  })
})

describe("scrollback colors", () => {
  test("keeps SGR colors and drops every other escape", () => {
    const styled = ansiToStyledText(
      "\x1b[1;38;2;10;132;255mready\x1b[0m \x1b[2Kplain\x1b]8;;https://x\x07",
      "#eceef2"
    )

    expect(styled.chunks.map((chunk) => chunk.text)).toEqual(["ready", " ", "plain"])
    expect(styled.chunks[0]?.fg?.toInts().slice(0, 3)).toEqual([10, 132, 255])
    expect(styled.chunks[2]?.fg?.toInts().slice(0, 3)).toEqual([236, 238, 242])
  })
})
