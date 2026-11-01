/** @jsxImportSource @opentui/react */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SyntaxStyle } from "@opentui/core"
import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { createSixbClient } from "@sixb/client"
import { Workspace } from "../src/tui/app"
import type { Connection } from "../src/tui/connection"
import type { LocalRunner } from "../src/tui/runner"
import { tuiColors } from "../src/tui/theme"

// The status line ends with the conversation's context against the model the next message goes
// to. Measuring it against another model must not touch the turn streaming meanwhile.

const THREAD = "agt_thread_1"
const RUN = "agt_run_live"

function languageModel(modelId: string, name: string, isDefault: boolean) {
  return {
    provider: "gateway",
    modelId,
    name,
    publisher: { id: "anthropic", name: "Anthropic" },
    isDefault,
    capabilities: { input: ["text"], output: ["text"] },
    reasoningLevels: ["provider-default"],
  }
}

/** A project whose conversation has a turn in flight, and the run streams it subscribes to. */
function fakeApi() {
  const contextReads: string[] = []
  let runSubscriptions = 0
  let started = false

  const thread = () => ({
    id: THREAD,
    projectId: "acme",
    kind: "conversation",
    title: "Read the repository",
    ownerPrincipal: { type: "system", id: "system" },
    activeRunId: started ? RUN : null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  })

  const answer = (method: string, url: URL): Response => {
    const path = url.pathname
    if (path === "/api/models") {
      return Response.json({
        language: [
          languageModel("anthropic/haiku", "Haiku", true),
          languageModel("anthropic/opus", "Opus", false),
        ],
      })
    }
    if (path === "/api/agent-threads" && method === "POST") {
      return Response.json({ thread: thread() }, { status: 201 })
    }
    if (path === `/api/agent-threads/${THREAD}/messages` && method === "POST") {
      started = true
      return Response.json({ run: { id: RUN } })
    }
    if (path === `/api/agent-threads/${THREAD}/approval-mode`) return Response.json(thread())
    if (path === `/api/agent-threads/${THREAD}`) return Response.json(thread())
    if (path === `/api/agent-threads/${THREAD}/messages`) return Response.json({ messages: [] })
    if (path === `/api/agent-threads/${THREAD}/runs`) {
      return Response.json({
        runs: started ? [{ id: RUN, threadId: THREAD, status: "running", createdAt: "x" }] : [],
      })
    }
    if (path === `/api/agent-threads/${THREAD}/approvals`) return Response.json({ approvals: [] })
    if (path === `/api/agent-threads/${THREAD}/context`) {
      const modelId = url.searchParams.get("modelId") ?? "latest"
      contextReads.push(modelId)
      const windowTokens = modelId === "anthropic/opus" ? 1_000_000 : 200_000
      return Response.json({
        model: { provider: "gateway", modelId: "anthropic/haiku" },
        windowTokens,
        limitTokens: windowTokens - 16_384,
        usedTokens: 38_200,
        lastCall: { inputTokens: 37_000, cacheReadInputTokens: 34_040, occurredAt: "x" },
      })
    }
    return new Response("not found", { status: 404 })
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(raw, server) {
      const url = new URL(raw.url)
      if (url.pathname === "/ws/agents") {
        return server.upgrade(raw) ? undefined : new Response("no upgrade", { status: 400 })
      }
      return answer(raw.method, url)
    },
    websocket: {
      message(_socket, message) {
        const parsed = JSON.parse(String(message)) as { readonly type?: string }
        if (parsed.type === "subscribe") runSubscriptions += 1
      },
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    contextReads,
    runSubscriptions: () => runSubscriptions,
  }
}

const runner = {
  folder: tmpdir(),
  claim: async () => false,
  claimIfHere: async () => {},
  runs: () => false,
  hearStop: () => {},
} as unknown as LocalRunner

let setup: TestRendererSetup | null = null
const cleanups: (() => Promise<void> | void)[] = []
const configRoot = process.env.XDG_CONFIG_HOME

beforeEach(async () => {
  const config = await mkdtemp(join(tmpdir(), "sixb-tui-context-"))
  process.env.XDG_CONFIG_HOME = config
  cleanups.push(() => rm(config, { recursive: true, force: true }))
})

afterEach(async () => {
  setup?.renderer.destroy()
  setup = null
  if (configRoot === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = configRoot
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function openTerminal(api: ReturnType<typeof fakeApi>, width: number) {
  cleanups.push(api.stop)
  const connection: Connection = {
    apiUrl: api.url,
    client: createSixbClient({ baseUrl: api.url, auth: { kind: "none" } }),
    project: { id: "acme", timeZone: "UTC", locale: "en" },
    authorization: async () => "",
  }
  setup = await testRender(
    <Workspace
      connection={connection}
      runner={runner}
      computerId="cmp_1"
      colors={tuiColors("dark")}
      syntax={{} as SyntaxStyle}
      version="sixb v0.0.0"
      initialSettings={{ place: "cloud", approvalMode: "auto" }}
      onExit={() => {}}
    />,
    { width, height: 30 }
  )
  // The app renders on its own clock, as in a terminal; React's act() checks do not apply.
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false })
  return setup
}

/** Turns of the loop until `done` holds, rendering each; the last frame. */
async function until(screen: TestRendererSetup, done: (frame: string) => boolean): Promise<string> {
  for (let turn = 0; turn < 2_000; turn += 1) {
    await screen.renderOnce()
    const frame = screen.captureCharFrame()
    if (done(frame)) return frame
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`The terminal never got there:\n${screen.captureCharFrame()}`)
}

async function startTurn(screen: TestRendererSetup, api: ReturnType<typeof fakeApi>) {
  await screen.mockInput.typeText("Read the repository")
  screen.mockInput.pressEnter()
  await until(screen, () => api.runSubscriptions() > 0 && api.contextReads.length > 0)
}

describe("the context in the terminal", () => {
  // Guard proof: in ThreadView (src/tui/app.tsx), put the context read back inside `reload` with
  // the model in its dependencies: choosing Opus reopens the run's stream, which replays the turn
  // from its start and doubles its text.
  test("measures another model without opening the running turn's stream again", async () => {
    const api = fakeApi()
    const screen = await openTerminal(api, 100)
    await startTurn(screen, api)
    expect(await until(screen, (frame) => frame.includes("ctx 38k/184k · 92% cached"))).toBeTruthy()
    const subscriptions = api.runSubscriptions()

    screen.mockInput.pressKey("o", { ctrl: true })
    await until(screen, (frame) => frame.includes("Opus"))
    // The palette opens on the model in effect; Opus is the next one.
    screen.mockInput.pressArrow("down")
    await screen.renderOnce()
    screen.mockInput.pressEnter()

    await until(screen, (frame) => frame.includes("ctx 38k/984k"))
    expect(api.contextReads).toContain("anthropic/opus")
    expect(api.runSubscriptions()).toBe(subscriptions)
  })

  test("leaves the cache share out of a narrow terminal's status line", async () => {
    const api = fakeApi()
    const screen = await openTerminal(api, 46)
    await startTurn(screen, api)

    const frame = await until(screen, (text) => text.includes("ctx 38k/184k"))
    expect(frame).not.toContain("cached")
  })

  // Removal proof: leave the `context` command out of ThreadView's slash commands; `/context` then
  // goes to the agent as a message.
  test("/context opens what the conversation uses of its model's window, and esc closes it", async () => {
    const api = fakeApi()
    const screen = await openTerminal(api, 100)
    await startTurn(screen, api)
    await until(screen, (frame) => frame.includes("ctx 38k/184k"))

    await screen.mockInput.typeText("/context")
    screen.mockInput.pressEnter()
    const panel = await until(screen, (frame) => frame.includes("38k of 184k tokens"))
    expect(panel).toContain("Free space")
    expect(panel).toContain("Kept for the answer")

    screen.mockInput.pressEscape()
    expect(await until(screen, (frame) => !frame.includes("Kept for the answer"))).toBeTruthy()
  })
})
