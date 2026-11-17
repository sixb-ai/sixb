import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { client } from "@sixb/client"
import {
  type DesktopComputerAccess,
  getAuthSessionQueryKey,
  listAgentComputersQueryKey,
} from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react"
import { useLayoutEffect } from "react"
import { MemoryRouter } from "react-router-dom"
import { AgentChat } from "../src/agent/agent-chat"
import { installDom } from "./helpers/dom"

const browser = installDom([
  "document",
  "navigator",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLFormElement",
  "HTMLInputElement",
  "Event",
  "CustomEvent",
  "EventTarget",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "PointerEvent",
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "localStorage",
])

const originalConfig = client.getConfig()
client.setConfig({ baseUrl: "https://api.sixb.test" })

const previousWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")

class FakeSocket {
  static readonly OPEN = 1
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  send(): void {}
  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

const radix = Bun.resolveSync("radix-ui", Bun.resolveSync("@sixb/ui/components", import.meta.dir))
const layoutEffect = Bun.resolveSync(
  "@radix-ui/react-use-layout-effect",
  Bun.resolveSync("@radix-ui/react-portal", Bun.resolveSync("@radix-ui/react-dialog", radix))
)
const loaded: typeof import("react").useLayoutEffect = (await import(layoutEffect)).useLayoutEffect
mock.module(layoutEffect, () => ({ useLayoutEffect }))

beforeAll(() => {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: FakeSocket,
  })
})

afterEach(async () => {
  cleanup()
  await new Promise((resolve) => setTimeout(resolve, 0))
  client.setConfig({ fetch: originalConfig.fetch })
  browser.localStorage.clear()
  delete (globalThis as { sixbDesktop?: unknown }).sixbDesktop
})

afterAll(() => {
  mock.module(layoutEffect, () => ({ useLayoutEffect: loaded }))
  client.setConfig({ baseUrl: originalConfig.baseUrl })
  if (previousWebSocket) Object.defineProperty(globalThis, "WebSocket", previousWebSocket)
  else Reflect.deleteProperty(globalThis, "WebSocket")
})

const ava = { type: "user", id: "usr_ava" } as const
const LAPTOP = {
  id: "cmp_laptop",
  name: "Ava's MacBook Pro",
  folders: ["/Users/ava/code/sixb", "/Users/ava/code/docs"],
}

function makeThread(overrides: Record<string, unknown> = {}) {
  return {
    id: "thr_1",
    projectId: "proj",
    kind: "conversation",
    ownerPrincipal: ava,
    owner: { ...ava, displayName: "Ava Chen" },
    participants: [],
    title: "Refactor auth",
    status: "active",
    messageCount: 2,
    activeRunId: null,
    createdAt: "2026-11-14T10:00:00.000Z",
    updatedAt: "2026-11-14T10:05:00.000Z",
    approvalMode: "manual",
    approvalModeSource: "fallback",
    ...overrides,
  }
}

const SIXB = { id: "cmp_laptop", folder: "/Users/ava/code/sixb" }
const DOCS = { id: "cmp_laptop", folder: "/Users/ava/code/docs" }

/** One turn: its message, its answer and its run, `minute` minutes in, wherever it ran. */
function turn(n: number, minute: number, place?: { id: string; folder: string }) {
  const at = (offset: number) => `2026-11-14T10:${String(minute + offset).padStart(2, "0")}:00.000Z`
  const message = {
    projectId: "proj",
    threadId: "thr_1",
    annotations: [],
    contentVersion: 1,
  }
  return {
    messages: [
      {
        ...message,
        id: `msg_${n}u`,
        runId: null,
        role: "user",
        authorPrincipal: ava,
        seq: n * 2 - 1,
        parts: [{ type: "text", text: `Question ${n}` }],
        createdAt: at(0),
      },
      {
        ...message,
        id: `msg_${n}a`,
        runId: `run_${n}`,
        role: "assistant",
        seq: n * 2,
        parts: [{ type: "text", text: `Answer ${n}.` }],
        createdAt: at(1),
      },
    ],
    run: {
      id: `run_${n}`,
      projectId: "proj",
      kind: "conversation",
      threadId: "thr_1",
      triggerMessageId: `msg_${n}u`,
      ...(place ? { runsOn: "computer", computer: place } : {}),
      status: "succeeded",
      attempt: 1,
      streamId: `s${n}`,
      requestedBy: ava,
      createdAt: at(0),
    },
  }
}

function renderHandoffChat(
  options: {
    thread?: Record<string, unknown>
    computers?: readonly (typeof LAPTOP)[]
    messages?: readonly Record<string, unknown>[]
    runs?: readonly Record<string, unknown>[]
    /** Holds a move to a folder until it settles. */
    moveGate?: Promise<void>
  } = {}
) {
  let currentThread: Record<string, unknown> = options.thread ?? makeThread()
  let computers = options.computers ?? [LAPTOP]
  const requests: string[] = []
  let computerReads = 0

  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const { pathname } = new URL(request.url)
    const method = request.method
    const rawBody = method === "GET" || method === "DELETE" ? "" : await request.text()
    requests.push(`${method} ${pathname}${rawBody ? ` ${rawBody}` : ""}`)

    if (pathname === "/api/agent") {
      return Response.json({ name: "Sixb", model: { provider: "gateway", modelId: "sonnet" } })
    }
    if (pathname === "/api/models") {
      return Response.json({
        language: [],
        image: [],
        audio: { speech: [], transcription: [] },
        capabilities: { run: false },
      })
    }
    if (pathname === "/api/agent/preferences") {
      return Response.json({ approvalMode: "manual", approvalModeSource: "fallback" })
    }
    if (pathname === "/api/agent-computers") {
      computerReads += 1
      return Response.json({ computers })
    }
    if (pathname === "/api/agent-approvals" || pathname === "/api/agent-threads/thr_1/approvals") {
      return Response.json({ approvals: [], hasMore: false, total: 0 })
    }
    if (pathname === "/api/agent-threads") {
      return Response.json({ threads: [currentThread], hasMore: false, total: 1 })
    }
    if (pathname === "/api/agent-threads/thr_1") {
      return Response.json(currentThread)
    }
    if (pathname === "/api/agent-threads/thr_1/messages") {
      return Response.json({
        messages: options.messages ?? [
          {
            id: "msg_1",
            projectId: "proj",
            threadId: "thr_1",
            runId: null,
            role: "user",
            authorPrincipal: ava,
            seq: 1,
            parts: [{ type: "text", text: "Start in cloud" }],
            annotations: [],
            contentVersion: 1,
            createdAt: "2026-11-14T10:00:00.000Z",
          },
          {
            id: "msg_2",
            projectId: "proj",
            threadId: "thr_1",
            runId: "run_1",
            role: "assistant",
            seq: 2,
            parts: [{ type: "text", text: "Ready." }],
            annotations: [],
            contentVersion: 1,
            createdAt: "2026-11-14T10:01:00.000Z",
          },
        ],
        authors: [],
        hasMore: false,
        total: 2,
      })
    }
    if (pathname === "/api/agent-threads/thr_1/runs") {
      // A page of them, newest first, as the server reads a limit.
      const limit = new URL(request.url).searchParams.get("limit")
      const runs = options.runs?.slice(0, limit === null ? undefined : Number(limit))
      return Response.json({
        runs: runs ?? [
          {
            id: "run_1",
            projectId: "proj",
            kind: "conversation",
            threadId: "thr_1",
            triggerMessageId: "msg_1",
            status: "succeeded",
            attempt: 1,
            streamId: "stream_1",
            requestedBy: ava,
            createdAt: "2026-11-14T10:00:00.000Z",
          },
        ],
        hasMore: false,
        total: 1,
      })
    }
    if (pathname === "/api/agent-threads/thr_1/computer" && method === "POST") {
      await options.moveGate
      const { computer } = JSON.parse(rawBody) as {
        computer: { id: string; name: string; folder: string }
      }
      currentThread = {
        ...currentThread,
        runsOn: "computer",
        computer: { ...computer, online: true },
        movedAt: "2026-11-14T10:10:00.000Z",
      }
      return Response.json(currentThread)
    }
    if (pathname === "/api/agent-threads/thr_1/computer" && method === "DELETE") {
      const { runsOn: _runsOn, computer: _computer, ...cloud } = currentThread
      currentThread = { ...cloud, movedAt: "2026-11-14T10:15:00.000Z" }
      return Response.json(currentThread)
    }
    if (pathname === "/api/object-types") return Response.json([])
    return Response.json({ error: "Not found" }, { status: 404 })
  }

  client.setConfig({ fetch: Object.assign(fetchMock, { preconnect: fetch.preconnect }) })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(getAuthSessionQueryKey(), {
    authenticated: true,
    user: { id: ava.id, email: "ava@sixb.test", displayName: "Ava Chen", groupIds: [] },
    session: { id: "ses_1", expiresAt: "2026-12-01T00:00:00.000Z" },
  })

  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AgentChat threadId="thr_1" onNavigateHome={() => {}} onNavigateThread={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>
  )
  return {
    view,
    requests,
    queryClient,
    computerReads: () => computerReads,
    /** Opens or closes `sixb` on the reader's computers, as the activity feed then tells the app. */
    connect: (connected: readonly (typeof LAPTOP)[]) => {
      computers = connected
      void queryClient.invalidateQueries({ queryKey: listAgentComputersQueryKey() })
    },
  }
}

describe("moving an existing conversation between cloud and local computer", () => {
  test("moves Cloud -> Computer -> Cloud -> Computer from the header", async () => {
    const { view, requests } = renderHandoffChat()

    // Open the Cloud pill in the header: it lists the folders of the connected computers.
    fireEvent.click(await view.findByRole("button", { name: /Runs in the cloud/ }))

    const dialog = within(await view.findByRole("dialog", { name: "Where this conversation runs" }))
    fireEvent.click(dialog.getByTitle("~/code/sixb"))

    await waitFor(() =>
      expect(
        requests.some((entry) => entry.startsWith("POST /api/agent-threads/thr_1/computer "))
      ).toBe(true)
    )
    expect(
      await view.findByRole("button", { name: /Runs in sixb on Ava's MacBook Pro/ })
    ).toBeDefined()
    expect(
      await view.findByText("Moved to sixb on Ava's MacBook Pro. The cloud's files stay behind.")
    ).toBeDefined()

    // Move Computer -> Cloud from the header control.
    fireEvent.click(view.getByRole("button", { name: /on Ava's MacBook Pro/ }))
    const onComputerMenu = within(
      await view.findByRole("dialog", { name: "Where this conversation runs" })
    )
    fireEvent.click(onComputerMenu.getByText("Cloud"))

    await waitFor(() => expect(requests).toContain("DELETE /api/agent-threads/thr_1/computer"))
    expect(await view.findByRole("button", { name: /Runs in the cloud/ })).toBeDefined()

    // Move Cloud -> Computer (another folder) again.
    fireEvent.click(view.getByRole("button", { name: /Runs in the cloud/ }))
    const thirdMenu = within(
      await view.findByRole("dialog", { name: "Where this conversation runs" })
    )
    fireEvent.click(thirdMenu.getByTitle("~/code/docs"))
    expect(
      await view.findByRole("button", { name: /Runs in docs on Ava's MacBook Pro/ })
    ).toBeDefined()
  })

  // Guard proof: return the place in useThreadPlace whatever the computers; the pill shows before
  // any computer is connected, and its menu offers nothing but the cloud.
  test("shows no place on a cloud conversation until one of its owner's computers connects", async () => {
    const { view, queryClient, connect } = renderHandoffChat({ computers: [] })

    expect(await view.findByText("Ready.")).toBeDefined()
    await waitFor(() =>
      expect(queryClient.getQueryData(listAgentComputersQueryKey())).toEqual({ computers: [] })
    )
    expect(view.queryByRole("button", { name: /Runs in/ })).toBeNull()

    connect([LAPTOP])
    expect(await view.findByRole("button", { name: /Runs in the cloud/ })).toBeDefined()
  })

  // Guard proof: drop the `movedAt` check from useThreadPlace; back in the cloud with no computer
  // connected, the control its owner just used to leave the computer is gone.
  test("keeps the place on a conversation that ran on a computer, and says how to go back", async () => {
    const { view, queryClient } = renderHandoffChat({
      computers: [],
      thread: makeThread({ movedAt: "2026-11-14T10:08:00.000Z" }),
    })

    fireEvent.click(await view.findByRole("button", { name: /Runs in the cloud/ }))
    const menu = within(await view.findByRole("dialog", { name: "Where this conversation runs" }))
    await waitFor(() =>
      expect(queryClient.getQueryData(listAgentComputersQueryKey())).toEqual({ computers: [] })
    )
    expect(
      menu.getByText(
        "None of your computers is connected. Open Sixb on one to move this conversation there."
      )
    ).toBeDefined()
  })

  // Guard proofs: list the computers as a computer's conversation opens, in useThreadPlace (the
  // first read comes before the menu opens); drop CurrentCheck from the folder row (the current
  // place reads only as a shade, as a focused row does); bring back the "Open sixb" card (the menu
  // tells a web user to run sixb in a folder, under the folder the conversation already runs in).
  test("shows where a computer's conversation runs, and in its menu that it's offline", async () => {
    const { view, computerReads } = renderHandoffChat({
      computers: [],
      thread: makeThread({
        runsOn: "computer",
        computer: { id: LAPTOP.id, name: LAPTOP.name, folder: SIXB.folder, online: false },
        movedAt: "2026-11-14T10:08:00.000Z",
      }),
    })

    const pill = await view.findByRole("button", { name: /on Ava's MacBook Pro/ })
    expect(computerReads()).toBe(0)

    fireEvent.click(pill)
    const menu = within(await view.findByRole("dialog", { name: "Where this conversation runs" }))
    await waitFor(() => expect(computerReads()).toBe(1))
    await waitFor(() => expect(menu.queryByText("Checking connected computers…")).toBeNull())

    expect(menu.getByText("· Offline")).toBeDefined()

    // The place it runs in is current, with a check apart from a hovered or focused row's shade,
    // and the header's label reads its status, which its dot only shows.
    const current = menu.getByRole("button", { current: true })
    expect(current.getAttribute("title")).toBe("~/code/sixb")
    expect(current.querySelector(".lucide-check")).not.toBeNull()
    expect(pill.getAttribute("aria-label")).toBe(
      "Runs in sixb on Ava's MacBook Pro, not available. Change where it runs"
    )
    expect(
      menu.getByText("Not available right now. Messages wait for it, or choose another place.")
    ).toBeDefined()
    expect(menu.getByText("Cloud")).toBeDefined()
    expect(menu.queryByText(/Open sixb/)).toBeNull()
  })

  test("lets Sixb Desktop pick a new folder and move a cloud conversation into it", async () => {
    const desktop: DesktopComputerAccess = {
      about: async () => ({ id: "cmp_mac", name: "Ava's Mac" }),
      folders: async () => [],
      pickFolder: async () => "/Users/ava/projects/api",
      allowFolder: async () => true,
      forgetFolder: async () => {},
    }
    Object.assign(globalThis, { sixbDesktop: { platform: "darwin", computer: desktop } })

    const { view, requests } = renderHandoffChat()
    expect(await view.findByText("Ready.")).toBeDefined()

    fireEvent.click(view.getByRole("button", { name: /Runs in the cloud/ }))
    const menu = within(await view.findByRole("dialog", { name: "Where this conversation runs" }))
    fireEvent.click(menu.getByText("Choose a folder…"))

    await waitFor(() =>
      expect(requests).toContain(
        'POST /api/agent-threads/thr_1/computer {"computer":{"id":"cmp_mac","name":"Ava\'s Mac","folder":"/Users/ava/projects/api"}}'
      )
    )
    expect(await view.findByRole("button", { name: /Runs in api on Ava's Mac/ })).toBeDefined()
  })

  test("shows every handoff marker across multi-hop cloud and computer turns", async () => {
    const { view } = renderHandoffChat({
      thread: makeThread({
        runsOn: "computer",
        computer: {
          id: "cmp_laptop",
          name: "Ava's MacBook Pro",
          folder: "/Users/ava/code/sixb",
          online: true,
        },
        movedAt: "2026-11-14T10:08:00.000Z",
      }),
      messages: [
        {
          id: "msg_1",
          projectId: "proj",
          threadId: "thr_1",
          runId: null,
          role: "user",
          authorPrincipal: ava,
          seq: 1,
          parts: [{ type: "text", text: "Turn 1 in cloud" }],
          annotations: [],
          contentVersion: 1,
          createdAt: "2026-11-14T10:00:00.000Z",
        },
        {
          id: "msg_2",
          projectId: "proj",
          threadId: "thr_1",
          runId: "run_1",
          role: "assistant",
          seq: 2,
          parts: [{ type: "text", text: "Cloud answer." }],
          annotations: [],
          contentVersion: 1,
          createdAt: "2026-11-14T10:01:00.000Z",
        },
        {
          id: "msg_3",
          projectId: "proj",
          threadId: "thr_1",
          runId: null,
          role: "user",
          authorPrincipal: ava,
          seq: 3,
          parts: [{ type: "text", text: "Turn 2 on laptop" }],
          annotations: [],
          contentVersion: 1,
          createdAt: "2026-11-14T10:03:00.000Z",
        },
        {
          id: "msg_4",
          projectId: "proj",
          threadId: "thr_1",
          runId: "run_2",
          role: "assistant",
          seq: 4,
          parts: [{ type: "text", text: "Laptop answer." }],
          annotations: [],
          contentVersion: 1,
          createdAt: "2026-11-14T10:04:00.000Z",
        },
        {
          id: "msg_5",
          projectId: "proj",
          threadId: "thr_1",
          runId: null,
          role: "user",
          authorPrincipal: ava,
          seq: 5,
          parts: [{ type: "text", text: "Turn 3 back in cloud" }],
          annotations: [],
          contentVersion: 1,
          createdAt: "2026-11-14T10:06:00.000Z",
        },
        {
          id: "msg_6",
          projectId: "proj",
          threadId: "thr_1",
          runId: "run_3",
          role: "assistant",
          seq: 6,
          parts: [{ type: "text", text: "Second cloud answer." }],
          annotations: [],
          contentVersion: 1,
          createdAt: "2026-11-14T10:07:00.000Z",
        },
      ],
      runs: [
        {
          id: "run_3",
          projectId: "proj",
          kind: "conversation",
          threadId: "thr_1",
          triggerMessageId: "msg_5",
          status: "succeeded",
          attempt: 1,
          streamId: "s3",
          requestedBy: ava,
          createdAt: "2026-11-14T10:06:00.000Z",
        },
        {
          id: "run_2",
          projectId: "proj",
          kind: "conversation",
          threadId: "thr_1",
          triggerMessageId: "msg_3",
          runsOn: "computer",
          status: "succeeded",
          attempt: 1,
          streamId: "s2",
          requestedBy: ava,
          createdAt: "2026-11-14T10:03:00.000Z",
        },
        {
          id: "run_1",
          projectId: "proj",
          kind: "conversation",
          threadId: "thr_1",
          triggerMessageId: "msg_1",
          status: "succeeded",
          attempt: 1,
          streamId: "s1",
          requestedBy: ava,
          createdAt: "2026-11-14T10:00:00.000Z",
        },
      ],
    })

    expect(
      await view.findByText("Moved to the computer. The cloud's files stay behind.")
    ).toBeDefined()
    expect(view.getByText("Moved to the cloud. The computer's files stay behind.")).toBeDefined()
    expect(
      view.getByText("Moved to sixb on Ava's MacBook Pro. The cloud's files stay behind.")
    ).toBeDefined()
  })

  // Guard proof: place each run by its `runsOn` alone in transcriptMoves; the hop from ~/code/sixb
  // to ~/code/docs loses its marker, and the first one no longer names its folder.
  test("marks each move, naming where it went, and none where the place stayed", async () => {
    const turns = [turn(1, 0), turn(2, 10, SIXB), turn(3, 20, SIXB), turn(4, 30, DOCS)]
    const { view } = renderHandoffChat({
      thread: makeThread({ movedAt: "2026-11-14T10:40:00.000Z" }),
      messages: turns.flatMap(({ messages }) => messages),
      runs: turns.map(({ run }) => run).reverse(),
    })

    expect(await view.findByText("Answer 4.")).toBeDefined()
    // The computer's name comes from the list of computers, which the header reads.
    await waitFor(() =>
      expect(
        view
          .getAllByRole("note")
          .map((note) => note.textContent)
          .filter((text) => text?.startsWith("Moved"))
      ).toEqual([
        "Moved to sixb on Ava's MacBook Pro. The cloud's files stay behind.",
        "Moved from sixb to docs. The files in sixb stay behind.",
        "Moved to the cloud. The files in docs stay behind.",
      ])
    )
  })

  // Guard proof: read the runs with `limit: "50"` again in useAgentConversation; the move before
  // the 51st most recent turn has no run on either side, and its marker goes.
  test("marks a move older than the latest fifty turns", async () => {
    const turns = [turn(1, 0), ...Array.from({ length: 51 }, (_, n) => turn(n + 2, n + 1, SIXB))]
    const { view } = renderHandoffChat({
      thread: makeThread({
        runsOn: "computer",
        computer: { id: SIXB.id, name: LAPTOP.name, folder: SIXB.folder, online: true },
        movedAt: "2026-11-14T10:00:30.000Z",
      }),
      messages: turns.flatMap(({ messages }) => messages),
      runs: turns.map(({ run }) => run).reverse(),
    })

    expect(await view.findByText("Answer 52.")).toBeDefined()
    expect(
      view.getByText("Moved to sixb on Ava's MacBook Pro. The cloud's files stay behind.")
    ).toBeDefined()
  })

  // Guard proofs: drop the `forked` branch from transcriptMoves (a fork shows no marker, before its
  // first turn or after it, while the core tells the model its first turn started elsewhere); anchor
  // a fork's marker by `movedAt` before its first turn (it lands among the copies of a source that
  // moved, or nowhere when the source moved before its first message).
  test("marks where a fork continues, before and after its first turn", async () => {
    const continued = "Continued in the cloud. The original conversation's files stay with it."
    const forkedAt = "2026-11-14T10:05:00.000Z"
    // A fork keeps its source's latest move, or its own creation for a source on a computer: the
    // marker follows the last copy whenever that move was.
    const sources = {
      onComputer: { copies: [turn(1, 0, SIXB), turn(2, 2, SIXB)], movedAt: forkedAt },
      inCloud: { copies: [turn(1, 0), turn(2, 2)], movedAt: undefined },
      movedBeforeLastCopies: {
        copies: [turn(1, 0), turn(2, 2, SIXB)],
        movedAt: "2026-11-14T10:01:30.000Z",
      },
      movedBeforeFirstCopy: {
        copies: [turn(1, 0, SIXB), turn(2, 2, SIXB)],
        movedAt: "2026-11-14T09:59:00.000Z",
      },
    }

    // The marker, and nothing else like it, follows the last copy's answer.
    const followsLastCopy = (view: ReturnType<typeof renderHandoffChat>["view"]) => {
      const [marker, ...others] = view.getAllByText(continued)
      expect(others).toHaveLength(0)
      const lastCopy = view.getByText("Answer 2.")
      const position = marker ? lastCopy.compareDocumentPosition(marker) : 0
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }

    for (const { copies, movedAt } of Object.values(sources)) {
      // The copies ran in the source: none of their runs is the fork's.
      const copied = copies.flatMap(({ messages }) => messages)
      const thread = makeThread({ createdAt: forkedAt, ...(movedAt ? { movedAt } : {}) })

      const before = renderHandoffChat({ thread, messages: copied, runs: [] })
      expect(await before.view.findByText(continued)).toBeDefined()
      followsLastCopy(before.view)
      before.view.unmount()

      const first = turn(3, 10)
      const after = renderHandoffChat({
        thread,
        messages: [...copied, ...first.messages],
        runs: [first.run],
      })
      expect(await after.view.findByText("Answer 3.")).toBeDefined()
      followsLastCopy(after.view)
      after.view.unmount()
    }
  })

  // Guard proof: drop the `waiting` question from useThreadPlace's moveToCloud; the header sends a
  // waiting message to the cloud at once, away from its folder's files, without a word.
  test("asks before a waiting message goes to the cloud from the header", async () => {
    const waiting = { ...turn(2, 10, SIXB).run, status: "queued" }
    const { view, requests } = renderHandoffChat({
      computers: [],
      thread: makeThread({
        runsOn: "computer",
        computer: { id: SIXB.id, name: LAPTOP.name, folder: SIXB.folder, online: false },
        movedAt: "2026-11-14T10:08:00.000Z",
        activeRunId: waiting.id,
      }),
      messages: [...turn(1, 0).messages, turn(2, 10, SIXB).messages[0] ?? {}],
      runs: [waiting, turn(1, 0).run],
    })

    fireEvent.click(await view.findByRole("button", { name: /on Ava's MacBook Pro/ }))
    const menu = within(await view.findByRole("dialog", { name: "Where this conversation runs" }))
    fireEvent.click(menu.getByText("Cloud"))

    const dialog = within(await view.findByRole("alertdialog"))
    expect(
      dialog.getByText(
        "In the cloud, the agent won't see the files in sixb. You can move the conversation back once sixb is available again."
      )
    ).toBeDefined()
    expect(requests).not.toContain("DELETE /api/agent-threads/thr_1/computer")

    fireEvent.click(dialog.getByRole("button", { name: "Run in the cloud" }))
    await waitFor(() => expect(requests).toContain("DELETE /api/agent-threads/thr_1/computer"))
  })

  // Guard proof: disable the notice's button on a move to the cloud alone, in useAgentConversation;
  // while the header moves the conversation to a folder, Continue in the cloud stays live and does
  // nothing.
  test("holds the offline notice while the header moves the conversation", async () => {
    let settle = () => {}
    const moveGate = new Promise<void>((resolve) => {
      settle = resolve
    })
    const { view, requests } = renderHandoffChat({
      moveGate,
      thread: makeThread({
        runsOn: "computer",
        computer: { id: LAPTOP.id, name: LAPTOP.name, folder: SIXB.folder, online: false },
        movedAt: "2026-11-14T10:08:00.000Z",
      }),
      computers: [{ ...LAPTOP, folders: [DOCS.folder] }],
    })

    const notice = await view.findByRole("button", { name: "Continue in the cloud" })
    expect((notice as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(view.getByRole("button", { name: /on Ava's MacBook Pro/ }))
    const menu = within(await view.findByRole("dialog", { name: "Where this conversation runs" }))
    fireEvent.click(await menu.findByTitle("~/code/docs"))
    await waitFor(() =>
      expect(
        requests.some((entry) => entry.startsWith("POST /api/agent-threads/thr_1/computer"))
      ).toBe(true)
    )

    expect(
      (view.getByRole("button", { name: "Continue in the cloud" }) as HTMLButtonElement).disabled
    ).toBe(true)
    settle()
  })

  // Guard proof: label the pill with placeChip(chooseFolderShort) again; a screen reader hears that
  // the conversation runs in "Choose a folder".
  test("names a computer's conversation with no folder yet as such", async () => {
    const { view } = renderHandoffChat({
      thread: makeThread({ runsOn: "computer", movedAt: "2026-11-14T10:08:00.000Z" }),
    })

    expect(
      await view.findByRole("button", {
        name: "No folder yet. Choose where this conversation runs",
      })
    ).toBeDefined()
  })
})
