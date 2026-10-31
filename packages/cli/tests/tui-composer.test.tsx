/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SyntaxStyle } from "@opentui/core"
import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { createSixbClient } from "@sixb/client"
import { Workspace } from "../src/tui/app"
import type { LocalRunner } from "../src/tui/runner"
import { tuiColors } from "../src/tui/theme"
import { Composer } from "../src/tui/ui"

// The composer is 36 columns of text at width 42: its bar and padding take 6.
const WORDS = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen"

let setup: TestRendererSetup | undefined
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  setup?.renderer.destroy()
  setup = undefined
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function composer(width: number): Promise<TestRendererSetup> {
  setup = await testRender(
    <Composer
      colors={tuiColors("dark")}
      placeholder="Ask anything…"
      status={[{ text: "This Mac", color: "blue" }]}
      focused
      onSubmit={() => true}
    />,
    { width, height: 20 }
  )
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false })
  // Laid out before typing, as a terminal's composer is: the text wraps at its width.
  await setup.renderOnce()
  return setup
}

/** The frame once the composer settles: a row count takes a render to reach its height. */
async function frame(screen: TestRendererSetup): Promise<string> {
  for (let turn = 0; turn < 3; turn += 1) await screen.renderOnce()
  return screen.captureCharFrame()
}

/** The composer's text rows, from the first to the one above the gap before its status line. */
function textRows(shown: string): string[] {
  const rows = shown.split("\n")
  const status = rows.findIndex((row) => row.includes("This Mac"))
  return rows
    .slice(0, status - 1)
    .map((row) => row.replace(/^\W*/, "").trim())
    .filter(Boolean)
}

describe("the composer", () => {
  // Guard proof: size the textarea by `lineCount` again in Composer (src/tui/ui.tsx); a long line
  // stays one row, scrolled to its end, and "one" is no longer on screen.
  test("grows a row for each row its text wraps to", async () => {
    const screen = await composer(42)
    await screen.mockInput.typeText(WORDS)

    const rows = textRows(await frame(screen))

    expect(rows.length).toBeGreaterThan(1)
    expect(rows.join(" ")).toBe(WORDS)
  })

  test("stops growing at its last row and scrolls past it", async () => {
    const screen = await composer(42)
    await screen.mockInput.typeText(`${WORDS} `.repeat(6).trim())

    expect(textRows(await frame(screen))).toHaveLength(8)
  })

  // Guard proof: drop `onSizeChange={fit}` from Composer; the rows stay as many as at width 80.
  test("rewraps when the terminal narrows", async () => {
    const screen = await composer(80)
    await screen.mockInput.typeText(WORDS)
    const wide = textRows(await frame(screen))

    screen.resize(42, 20)
    const narrow = textRows(await frame(screen))

    expect(narrow.length).toBeGreaterThan(wide.length)
    expect(narrow.join(" ")).toBe(WORDS)
  })
})

/** The home screen, against an API that answers its models and nothing else. */
async function workspace(onExit: () => void): Promise<TestRendererSetup> {
  const api = Bun.serve({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/api/models"
        ? Response.json({ language: [] })
        : new Response("not found", { status: 404 }),
  })
  const configRoot = process.env.XDG_CONFIG_HOME
  const config = await mkdtemp(join(tmpdir(), "sixb-tui-composer-"))
  process.env.XDG_CONFIG_HOME = config
  cleanups.push(() => api.stop(true))
  cleanups.push(async () => {
    if (configRoot === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = configRoot
    await rm(config, { recursive: true, force: true })
  })

  const url = `http://127.0.0.1:${api.port}`
  setup = await testRender(
    <Workspace
      connection={{
        apiUrl: url,
        client: createSixbClient({ baseUrl: url, auth: { kind: "none" } }),
        project: { id: "acme", timeZone: "UTC", locale: "en" },
        authorization: async () => "",
      }}
      runner={{ folder: config, claimIfHere: async () => {} } as unknown as LocalRunner}
      computerId="cmp_1"
      colors={tuiColors("dark")}
      syntax={{} as SyntaxStyle}
      version="sixb v0.0.0"
      initialSettings={{ place: "cloud", approvalMode: "manual" }}
      onExit={onExit}
    />,
    // As the terminal's renderer is: the app decides what ctrl+c does.
    { width: 100, height: 30, exitOnCtrlC: false }
  )
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false })
  await setup.renderOnce()
  return setup
}

describe("ctrl+c", () => {
  // Guard proof: drop the `draft.current?.()` line from Workspace's keys (src/tui/app.tsx); the
  // first ctrl+c arms the quit and leaves the draft, and the second quits.
  test("clears a draft first, then quits from an empty composer", async () => {
    let exits = 0
    const screen = await workspace(() => {
      exits += 1
    })
    await screen.mockInput.typeText("summarize my latest emails")
    expect(await frame(screen)).toContain("summarize my latest emails")

    screen.mockInput.pressCtrlC()
    const cleared = await frame(screen)
    expect(cleared).not.toContain("summarize my latest emails")
    expect(cleared).toContain("Ask anything…")
    expect(cleared).not.toContain("Press ctrl+c again to quit")

    screen.mockInput.pressCtrlC()
    expect(await frame(screen)).toContain("Press ctrl+c again to quit")
    screen.mockInput.pressCtrlC()
    expect(exits).toBe(1)
  })
})
