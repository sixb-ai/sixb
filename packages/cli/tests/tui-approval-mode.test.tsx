/** @jsxImportSource @opentui/react */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
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
import type { ApprovalMode } from "../src/tui/settings"
import { tuiColors } from "../src/tui/theme"

// In a conversation the terminal runs in the person's mode there, as the web does: the thread's,
// which "always" on a card raises and shift+tab sets. A new conversation starts in the terminal's.

const THREAD = "agt_thread_1"
const APPROVAL = "apr_1"

interface Request {
  readonly method: string
  readonly path: string
  readonly body: Record<string, unknown>
}

/** A project with one conversation, its mode for the person, and a call held in its first turn. */
async function fakeApi(input: { readonly holdFirstTurn: boolean }) {
  const state: { mode?: ApprovalMode; held: boolean } = { held: false }
  const requests: Request[] = []
  const waiting: { readonly match: (request: Request) => boolean; resolve(): void }[] = []

  const thread = () => ({
    id: THREAD,
    projectId: "acme",
    kind: "conversation",
    title: "Close the case",
    ownerPrincipal: { type: "system", id: "system" },
    activeRunId: null,
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
    ...(state.mode ? { approvalMode: state.mode, approvalModeSource: "thread" } : {}),
  })

  const answer = (request: Request): Response => {
    const { method, path, body } = request
    if (path === "/api/models") return Response.json({ language: [] })
    if (path === "/api/agent-threads" && method === "POST") {
      return Response.json({ thread: thread() }, { status: 201 })
    }
    if (path === `/api/agent-threads/${THREAD}`) return Response.json(thread())

    if (path === `/api/agent-threads/${THREAD}/approval-mode`) {
      state.mode = body.approvalMode as ApprovalMode
      return Response.json(thread())
    }
    if (path === `/api/agent-threads/${THREAD}/messages` && method === "POST") {
      if (count("POST", `/api/agent-threads/${THREAD}/messages`) === 1) {
        state.held = input.holdFirstTurn
      }
      return Response.json({ run: { id: `agt_run_${requests.length}` } })
    }
    if (path === `/api/agent-threads/${THREAD}/messages`) return Response.json({ messages: [] })
    if (path === `/api/agent-threads/${THREAD}/runs`) return Response.json({ runs: [] })
    if (path === `/api/agent-threads/${THREAD}/approvals`) {
      return Response.json({ approvals: state.held ? [heldCall()] : [] })
    }

    // "Always in this thread" raises the person's mode there to one that allows the call.
    if (path === `/api/agent-threads/${THREAD}/approvals/${APPROVAL}/decision`) {
      state.held = false
      if (body.always === true) state.mode = "accept-edits"
      return Response.json({ approval: { ...heldCall(), status: "approved" } })
    }

    return new Response("not found", { status: 404 })
  }

  const count = (method: string, path: string) =>
    requests.filter((request) => request.method === method && request.path === path).length

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(raw, server) {
      const path = new URL(raw.url).pathname
      if (path === "/ws/agents") {
        return server.upgrade(raw) ? undefined : new Response("no upgrade", { status: 400 })
      }

      const text = raw.method === "GET" ? "" : await raw.text()
      const request = { method: raw.method, path, body: text ? JSON.parse(text) : {} }
      requests.push(request)
      const response = answer(request)

      for (const waiter of waiting.splice(0)) {
        if (waiter.match(request)) waiter.resolve()
        else waiting.push(waiter)
      }
      return response
    },
    websocket: { message() {} },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
    /** The person's messages in the conversation, as the API received them. */
    messages: () =>
      requests.filter(
        (request) =>
          request.method === "POST" && request.path === `/api/agent-threads/${THREAD}/messages`
      ),
    /** Resolves once the API has received the `nth` request to `method path`. */
    received(method: string, path: string, nth = 1): Promise<void> {
      if (count(method, path) >= nth) return Promise.resolve()
      return new Promise((resolve) => {
        waiting.push({
          match: (request) =>
            request.method === method && request.path === path && count(method, path) >= nth,
          resolve,
        })
      })
    },
  }
}

function heldCall() {
  return {
    id: APPROVAL,
    threadId: THREAD,
    runId: "agt_run_2",
    status: "pending",
    call: {
      kind: "action",
      actionId: "close-case",
      subject: { kind: "none" },
      params: {},
      effect: "internal",
    },
  }
}

const runner = {
  folder: tmpdir(),
  claim: async () => false,
  claimIfHere: async () => {},
  runs: () => false,
  hearStop: () => {},
  onElsewhere: () => () => {},
} as unknown as LocalRunner

let setup: TestRendererSetup | null = null
const cleanups: (() => Promise<void> | void)[] = []
const configRoot = process.env.XDG_CONFIG_HOME

beforeEach(async () => {
  // The terminal's own settings, and the folders of its conversations, live in this config.
  const config = await mkdtemp(join(tmpdir(), "sixb-tui-approval-"))
  process.env.XDG_CONFIG_HOME = config
  cleanups.push(() => rm(config, { recursive: true, force: true }))
})

afterEach(async () => {
  setup?.renderer.destroy()
  setup = null
  setSystemTime()
  if (configRoot === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = configRoot
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function openTerminal(api: Awaited<ReturnType<typeof fakeApi>>, mode: ApprovalMode) {
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
      // Only an answer's text uses it, and these turns have none.
      syntax={{} as SyntaxStyle}
      version="sixb v0.0.0"
      initialSettings={{ place: "cloud", approvalMode: mode, continueFromWeb: false }}
      onExit={() => {}}
    />,
    { width: 100, height: 30 }
  )
  // The app renders on its own clock, as in a terminal; React's act() checks do not apply.
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false })
  return setup
}

/** The frame once it shows `text`: the app answers a request over a few turns of the loop. */
async function until(screen: TestRendererSetup, text: string): Promise<string> {
  for (let turn = 0; turn < 2_000; turn += 1) {
    await screen.renderOnce()
    const frame = screen.captureCharFrame()
    if (frame.includes(text)) return frame
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`The terminal never showed "${text}":\n${screen.captureCharFrame()}`)
}

async function send(
  screen: TestRendererSetup,
  api: Awaited<ReturnType<typeof fakeApi>>,
  text: string
) {
  const sent = api.messages().length + 1
  await screen.mockInput.typeText(text)
  screen.mockInput.pressEnter()
  await api.received("POST", `/api/agent-threads/${THREAD}/messages`, sent)
}

describe("the terminal's approval mode", () => {
  // Guard proof: in ThreadView's send (src/tui/app.tsx), send `approvalMode: settings.approvalMode`
  // again, or drop `onThreadRead` from reload: the message after "always" carries `manual`, or the
  // status still reads Ask first.
  test("follows the thread after always on a card: the next message carries no mode", async () => {
    const api = await fakeApi({ holdFirstTurn: true })
    const screen = await openTerminal(api, "manual")

    await send(screen, api, "Close the case")
    await until(screen, "Always in this thread")
    expect(await until(screen, "Ask first")).not.toContain("Allow edits")

    // The card ignores keys for a moment after it appears.
    setSystemTime(new Date(Date.now() + 1_000))
    screen.mockInput.pressKey("a")
    await api.received("POST", `/api/agent-threads/${THREAD}/approvals/${APPROVAL}/decision`)
    expect(await until(screen, "Allow edits")).not.toContain("Ask first")

    await send(screen, api, "Close the next one")

    expect(api.messages().map((message) => message.body.approvalMode)).toEqual([
      undefined,
      undefined,
    ])
  })

  // Guard proof: in Workspace's chooseApproval (src/tui/app.tsx), return after `setSettings` in a
  // conversation too: the status keeps reading the thread's Ask first, and no mode reaches it.
  test("keeps a mode chosen with shift+tab on the thread, as the web does", async () => {
    const api = await fakeApi({ holdFirstTurn: false })
    const screen = await openTerminal(api, "manual")

    await send(screen, api, "Close the case")
    // Read by the conversation, not the home screen it left.
    await api.received("GET", `/api/agent-threads/${THREAD}`)
    await until(screen, "Ask first")

    screen.mockInput.pressTab({ shift: true })
    expect(await until(screen, "Allow edits")).not.toContain("Ask first")
    await api.received("PUT", `/api/agent-threads/${THREAD}/approval-mode`, 2)
    await send(screen, api, "Close the next one")

    const modes = api.requests.filter((request) => request.method === "PUT")
    expect(modes.map((request) => request.body.approvalMode)).toEqual(["manual", "accept-edits"])
    // Until the terminal reads the saved mode back, the message carries the one it shows.
    expect([undefined, "accept-edits"] as unknown[]).toContain(
      api.messages().at(-1)?.body.approvalMode
    )
  })

  // Guard proof: in Home's send (src/tui/app.tsx), drop the `setAgentThreadApprovalMode` call:
  // the thread never gets the terminal's mode, and its next turns run in the person's default.
  test("starts a new conversation in the terminal's mode, kept on the thread", async () => {
    const api = await fakeApi({ holdFirstTurn: false })
    const screen = await openTerminal(api, "auto")

    await send(screen, api, "Close the case")

    const created = api.requests.findIndex((request) => request.path === "/api/agent-threads")
    const [kept] = api.requests.filter((request) => request.method === "PUT")
    expect(kept?.body).toEqual({ approvalMode: "auto" })
    expect(api.requests.indexOf(kept as Request)).toBeGreaterThan(created)
    expect(api.requests.indexOf(kept as Request)).toBeLessThan(
      api.requests.indexOf(api.messages()[0] as Request)
    )
    await until(screen, "Full access")
  })
})
