/** @jsxImportSource @opentui/react */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SyntaxStyle } from "@opentui/core"
import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { createSixbClient } from "@sixb/client"
import type { Connection } from "../src/lib/connection"
import type { LocalRunner } from "../src/runner/local-runner"
import { Workspace } from "../src/tui/app"
import { folderName } from "../src/tui/moves"
import { computerNameInText } from "../src/tui/settings"
import { tuiColors } from "../src/tui/theme"

// In a conversation, `/here` and `/cloud` move it. On the home screen the same words choose where
// new conversations start, and a conversation's take their place while it is open.

const THREAD = "agt_thread_1"
const COMPUTER = "cmp_1"
const FOLDER = tmpdir()

/** What a move says, from where the conversation's first turn ran. */
const MOVED_TO_CLOUD = `Moved to the cloud. The files in ${folderName(FOLDER)} stay behind.`
const MOVED_HERE = `Moved to ${folderName(FOLDER)} on ${computerNameInText()}. The cloud's files stay behind.`

interface Request {
  readonly method: string
  readonly path: string
  readonly body: Record<string, unknown>
}

/**
 * A project with one conversation of the person's, in the cloud or in this folder. `unread` holds
 * every read of it, as a slow network would. `busy` refuses every move, as the API does while a
 * reply runs or a request waits for approval.
 */
function fakeApi(input: {
  readonly inFolder: boolean
  readonly unread?: boolean
  readonly busy?: "reply" | "approval"
  /** Someone else's conversation, which the person only takes part in. */
  readonly theirs?: boolean
}) {
  const state = { inFolder: input.inFolder }
  const requests: Request[] = []
  const waiting: { readonly match: (request: Request) => boolean; resolve(): void }[] = []

  const thread = () => ({
    id: THREAD,
    projectId: "acme",
    kind: "conversation",
    title: "Close the case",
    ownerPrincipal: input.theirs
      ? { type: "user", id: "usr_owner" }
      : { type: "system", id: "system" },
    owner: input.theirs
      ? { type: "user", id: "usr_owner", displayName: "Ada" }
      : { type: "system", id: "system" },
    activeRunId: null,
    approvalMode: "manual",
    approvalModeSource: "thread",
    createdAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
    ...(state.inFolder
      ? { runsOn: "computer", computer: { id: COMPUTER, name: "Studio", folder: FOLDER } }
      : {}),
  })

  // Its first turn ran where it started.
  const firstTurn = {
    id: "agt_run_first",
    projectId: "acme",
    kind: "conversation",
    threadId: THREAD,
    triggerMessageId: "msg_first",
    status: "succeeded",
    createdAt: "2026-11-16T00:00:00.000Z",
    ...(input.inFolder ? { runsOn: "computer", computer: { id: COMPUTER, folder: FOLDER } } : {}),
  }

  const answer = ({ method, path }: Request): Response => {
    if (path === "/api/models") return Response.json({ language: [] })
    if (path === "/api/agent-threads" && method === "POST") {
      return Response.json({ thread: thread() }, { status: 201 })
    }
    if (path === `/api/agent-threads/${THREAD}`) return Response.json(thread())
    if (path === `/api/agent-threads/${THREAD}/approval-mode`) return Response.json(thread())

    if (path === `/api/agent-threads/${THREAD}/computer`) {
      if (input.busy) {
        return Response.json(
          {
            error: "[Sixb] A turn is running in the cloud: stop it, or let it end, first.",
            code: "active_run_exists",
          },
          { status: 409 }
        )
      }

      state.inFolder = method === "POST"
      return Response.json(thread())
    }

    if (path === `/api/agent-threads/${THREAD}/messages` && method === "POST") {
      return Response.json({ run: { id: `agt_run_${requests.length}` } })
    }
    if (path === `/api/agent-threads/${THREAD}/messages`) return Response.json({ messages: [] })
    if (path === `/api/agent-threads/${THREAD}/runs`) return Response.json({ runs: [firstTurn] })
    if (path === `/api/agent-threads/${THREAD}/approvals`) {
      return Response.json({ approvals: input.busy === "approval" ? [heldCall()] : [] })
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

      if (input.unread && path === `/api/agent-threads/${THREAD}`) await new Promise(() => {})
      return response
    },
    websocket: { message() {} },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    /** Every move of the conversation, as the API received them. */
    moves: () =>
      requests.filter((request) => request.path === `/api/agent-threads/${THREAD}/computer`),
    /** The person's messages in the conversation. */
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
    id: "apr_1",
    threadId: THREAD,
    runId: "agt_run_1",
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
  folder: FOLDER,
  claim: async () => false,
  claimIfHere: async () => {},
  runs: () => false,
  hearStop: () => {},
  onElsewhere: () => () => {},
  onBackground: () => () => {},
  backgroundCommands: () => [],
  runsHere: () => false,
} as unknown as LocalRunner

let setup: TestRendererSetup | null = null
const cleanups: (() => Promise<void> | void)[] = []
const configRoot = process.env.XDG_CONFIG_HOME

beforeEach(async () => {
  // This computer's id is kept in this config, and a move to this folder names it.
  const config = await mkdtemp(join(tmpdir(), "sixb-tui-place-"))
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

/** The terminal, in the conversation its first message started. */
/**
 * The conversation once it shows `ready`. A conversation paused on an approval never shows the
 * composer's "Ask anything": its card can win the first frame, so that test waits for the card.
 */
async function openConversation(
  api: ReturnType<typeof fakeApi>,
  ready = "Ask anything"
): Promise<TestRendererSetup> {
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
      computerId={COMPUTER}
      colors={tuiColors("dark")}
      // Only an answer's text uses it, and these turns have none.
      syntax={{} as SyntaxStyle}
      version="sixb v0.0.0"
      initialSettings={{
        place: "cloud",
        approvalMode: "manual",
        continueFromWeb: false,
        keepAwake: false,
      }}
      onExit={() => {}}
    />,
    { width: 100, height: 30 }
  )
  // The app renders on its own clock, as in a terminal; React's act() checks do not apply.
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false })

  await setup.mockInput.typeText("Close the case")
  setup.mockInput.pressEnter()
  await api.received("POST", `/api/agent-threads/${THREAD}/messages`)
  // Read by the conversation, not the home screen it left.
  await api.received("GET", `/api/agent-threads/${THREAD}`)
  await until(setup, ready)
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

describe("moving a conversation with a slash command", () => {
  // Guard proof: in ThreadView (src/tui/app.tsx), append the conversation's commands after
  // `props.slashCommands` instead of putting them in their place: the menu lists the home
  // screen's /cloud first, and Enter runs it.
  test("/cloud in a conversation moves it to the cloud", async () => {
    const api = fakeApi({ inFolder: true })
    const screen = await openConversation(api)

    await screen.mockInput.typeText("/cloud")
    const menu = await until(screen, "Move this conversation to the cloud")
    expect(menu).not.toContain("Run new conversations in the cloud")

    screen.mockInput.pressEnter()
    await api.received("DELETE", `/api/agent-threads/${THREAD}/computer`)
    await until(screen, MOVED_TO_CLOUD)
  })

  // Guard proof: as above; the home screen's /here sets where new conversations start instead.
  test("/here in a conversation moves it to this folder", async () => {
    const api = fakeApi({ inFolder: false })
    const screen = await openConversation(api)

    await screen.mockInput.typeText("/here")
    const menu = await until(screen, "Move this conversation to this folder")
    expect(menu).not.toContain("Run new conversations")

    screen.mockInput.pressEnter()
    await api.received("POST", `/api/agent-threads/${THREAD}/computer`)
    await until(screen, MOVED_HERE)
    expect(api.moves().map((move) => move.body.computer)).toEqual([
      expect.objectContaining({ folder: FOLDER }),
    ])
  })

  // Guard proof: drop the conversation's /cloud while it already runs there, as the first version
  // did: the home screen's runs instead, and nothing says the conversation stayed.
  test("/cloud where it already runs says so, and nothing reaches the agent", async () => {
    const api = fakeApi({ inFolder: false })
    const screen = await openConversation(api)

    await screen.mockInput.typeText("/cloud")
    await until(screen, "This conversation runs in the cloud")
    screen.mockInput.pressEnter()

    // The composer clears once the text was taken: sent to the agent, it would be by now.
    expect(await until(screen, "Ask anything")).toContain("This conversation runs in the cloud")
    expect(api.moves()).toEqual([])
    expect(api.messages()).toHaveLength(1)
  })

  // Guard proof: drop moveCommand's case for a thread not read yet (src/tui/app.tsx): the menu
  // tells the owner that only its owner can move the conversation.
  test("before the conversation is read, /here neither alarms nor moves", async () => {
    const api = fakeApi({ inFolder: false, unread: true })
    const screen = await openConversation(api)

    await screen.mockInput.typeText("/here")
    const menu = await until(screen, "Move this conversation to this folder")
    expect(menu).not.toContain("Only its owner")
    screen.mockInput.pressEnter()

    expect(await until(screen, "Ask anything")).toContain("Reading the conversation…")
    expect(api.moves()).toEqual([])
  })
})

describe("moving a conversation back where its last turn ran", () => {
  // Guard proof: in movedNotice (src/tui/moves.ts), start from the conversation's current place
  // rather than its last turn's: the way back reads "The cloud's files stay behind", though no
  // turn ran in the cloud.
  test("says nothing moved since its last reply", async () => {
    const api = fakeApi({ inFolder: true })
    const screen = await openConversation(api)

    await screen.mockInput.typeText("/cloud")
    await until(screen, "Move this conversation to the cloud")
    screen.mockInput.pressEnter()
    await until(screen, MOVED_TO_CLOUD)

    await screen.mockInput.typeText("/here")
    await until(screen, "Move this conversation to this folder")
    screen.mockInput.pressEnter()
    await until(screen, "Back in this folder. Nothing moved since its last reply.")
  })
})

describe("moving a conversation with ctrl+g", () => {
  // Guard proof: in ThreadView's keys (src/tui/app.tsx), move on ctrl+f again, or on the first
  // ctrl+g: the terminal never asks for a second press, and ctrl+f has started a move by the time
  // the message is sent.
  test("leaves the cloud on a second press, while ctrl+f stays a step right", async () => {
    const api = fakeApi({ inFolder: false })
    const screen = await openConversation(api)
    await until(screen, "ctrl+g move here")

    // ctrl+b steps left and ctrl+f right again, so the "e" ends the word.
    await screen.mockInput.typeText("Close the cas")
    screen.mockInput.pressKey("b", { ctrl: true })
    screen.mockInput.pressKey("f", { ctrl: true })
    await screen.mockInput.typeText("e")

    screen.mockInput.pressKey("g", { ctrl: true })
    await until(screen, "Press ctrl+g again to move it to this folder")
    screen.mockInput.pressKey("g", { ctrl: true })
    await api.received("POST", `/api/agent-threads/${THREAD}/computer`)
    await until(screen, MOVED_HERE)

    // Sent after the move: one that ctrl+f had started would have reached the API by now.
    screen.mockInput.pressEnter()
    await api.received("POST", `/api/agent-threads/${THREAD}/messages`, 2)
    expect(api.messages().at(-1)?.body.text).toBe("Close the case")
    expect(api.moves()).toHaveLength(1)
  })

  // Guard proof: as above, with the move on the first ctrl+g.
  test("goes back to the cloud on a second press too", async () => {
    const api = fakeApi({ inFolder: true })
    const screen = await openConversation(api)
    await until(screen, "ctrl+g move to cloud")

    screen.mockInput.pressKey("g", { ctrl: true })
    await until(screen, "Press ctrl+g again to move it to the cloud")
    screen.mockInput.pressKey("g", { ctrl: true })
    await api.received("DELETE", `/api/agent-threads/${THREAD}/computer`)

    await until(screen, MOVED_TO_CLOUD)
    expect(api.moves()).toHaveLength(1)
  })
})

describe("moving a conversation from the ctrl+p palette", () => {
  // Guard proof: in Workspace (src/tui/app.tsx), pass `threadMoves: null` to commandItems: the
  // palette offers to run new conversations in the cloud instead. List every move in ThreadView's
  // palette effect: the one that cannot happen shows too.
  test("lists the slash menu's moves, in its words", async () => {
    const api = fakeApi({ inFolder: true })
    const screen = await openConversation(api)
    await until(screen, "ctrl+g move to cloud")

    screen.mockInput.pressKey("p", { ctrl: true })
    const palette = await until(screen, "Move this conversation to the cloud")
    expect(palette).not.toContain("This conversation runs in this folder")
    expect(palette).not.toContain("Run new conversations")

    // Filtered on the next frame: enter picks from what it shows.
    await screen.mockInput.typeText("to the cloud")
    await screen.renderOnce()
    screen.mockInput.pressEnter()
    await api.received("DELETE", `/api/agent-threads/${THREAD}/computer`)
    await until(screen, MOVED_TO_CLOUD)
  })
})

describe("moving someone else's conversation from the ctrl+p palette", () => {
  // Guard proof: in ThreadView's palette effect (src/tui/app.tsx), list every move: the palette
  // shows "Only its owner can move this conversation" twice.
  test("lists no move, nor where new conversations start", async () => {
    const api = fakeApi({ inFolder: false, theirs: true })
    const screen = await openConversation(api)
    // Read once the slash menu says why it can't move; the menu then closes with its text.
    await screen.mockInput.typeText("/cloud")
    await until(screen, "Only its owner can move this conversation")
    for (const _ of "/cloud") screen.mockInput.pressBackspace()
    await until(screen, "Ask anything")

    screen.mockInput.pressKey("p", { ctrl: true })
    const palette = await until(screen, "Open a conversation")
    expect(palette).not.toContain("Only its owner")
    expect(palette).not.toContain("Run new conversations")
  })
})

describe("a move refused while the conversation is busy", () => {
  // Guard proof: in ThreadView's moveRefused (src/tui/app.tsx), say `errorText(error)` for every
  // error: the terminal shows the API's "[Sixb] A turn is running…" instead.
  test("says how to free it: stop the reply", async () => {
    const api = fakeApi({ inFolder: false, busy: "reply" })
    const screen = await openConversation(api)

    await screen.mockInput.typeText("/here")
    await until(screen, "Move this conversation to this folder")
    screen.mockInput.pressEnter()

    const frame = await until(screen, "A reply is running: press esc twice to stop it")
    expect(frame).not.toContain("[Sixb]")
  })

  // Guard proof: as above.
  test("says how to free it: answer the request", async () => {
    const api = fakeApi({ inFolder: false, busy: "approval" })
    const screen = await openConversation(api, "Always in this thread")

    screen.mockInput.pressKey("g", { ctrl: true })
    await until(screen, "Press ctrl+g again")
    screen.mockInput.pressKey("g", { ctrl: true })

    const frame = await until(screen, "A request waits for your approval: answer it")
    expect(frame).not.toContain("[Sixb]")
  })
})
