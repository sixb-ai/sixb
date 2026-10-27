import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { client } from "@sixb/client"
import { getAuthSessionQueryKey } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react"
import { useLayoutEffect } from "react"
import { MemoryRouter } from "react-router-dom"
import { AgentChat } from "../src/agent/agent-chat"
import type { LanguageModel } from "../src/agent/types"
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
// Generated query keys carry the client's base URL, so it is set before any key is built.
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

// Radix picks its layout effect when it loads, a no-op without a `document`, and its popovers then
// never mount. This file or another of the run loads it before the window exists, so it is given
// React's own, and its own back after the file.
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
  browser.happyDOM.setViewport({ width: 1600, height: 1000 })
})

afterAll(() => {
  mock.module(layoutEffect, () => ({ useLayoutEffect: loaded }))
  client.setConfig({ baseUrl: originalConfig.baseUrl })
  if (previousWebSocket) Object.defineProperty(globalThis, "WebSocket", previousWebSocket)
  else Reflect.deleteProperty(globalThis, "WebSocket")
})

const at = "2026-10-25T09:00:00.000Z"
const dana = { type: "user", id: "usr_dana" } as const

function model(modelId: string, name: string, overrides: Partial<LanguageModel> = {}) {
  return {
    provider: "gateway",
    modelId,
    name,
    publisher: { id: "anthropic", name: "Anthropic" },
    isDefault: false,
    capabilities: { input: ["text"], output: ["text"], reasoning: true },
    reasoningLevels: ["provider-default", "low", "high"],
    ...overrides,
  } satisfies LanguageModel
}

const flash = model("deepseek/flash", "Flash", { tier: "light", description: "Quick lookups" })
const sonnet = model("anthropic/sonnet", "Sonnet", { tier: "standard", isDefault: true })
const opus = model("anthropic/opus", "Opus", { tier: "heavy", description: "Hard analysis" })
const tiers = [flash, sonnet, opus]
const list = tiers.map(({ tier: _tier, ...entry }) => entry)

function thread(id: string) {
  return {
    id,
    projectId: "proj",
    ownerPrincipal: dana,
    owner: { ...dana, displayName: "Dana Reyes" },
    participants: [],
    title: "Payables",
    status: "active",
    messageCount: 0,
    activeRunId: null,
    createdAt: at,
    updatedAt: at,
    approvalMode: "manual",
    approvalModeSource: "fallback",
  }
}

/** The bodies of the messages the chat posted. */
type Posted = Record<string, unknown>[]

function api(language: readonly LanguageModel[], routing: boolean | undefined, posted: Posted) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const path = new URL(request.url).pathname
    const method = request.method

    if (path === "/api/agent") {
      return Response.json({
        name: "Sixb",
        model: { provider: "gateway", modelId: sonnet.modelId },
      })
    }
    if (path === "/api/models") {
      return Response.json({
        language,
        ...(routing === undefined ? {} : { languageRouting: routing }),
      })
    }
    if (path === "/api/agent/preferences") {
      return Response.json({ approvalMode: "manual", approvalModeSource: "fallback" })
    }
    if (path === "/api/agent-approvals" || /^\/api\/agent-threads\/[^/]+\/approvals$/.test(path)) {
      return Response.json({ approvals: [], hasMore: false, total: 0 })
    }
    if (path === "/api/agent-threads" && method === "POST") {
      return Response.json({ thread: thread("thr_new") }, { status: 201 })
    }
    if (path === "/api/agent-threads")
      return Response.json({ threads: [], hasMore: false, total: 0 })

    const [, threadId, part] = path.match(/^\/api\/agent-threads\/([^/]+)(?:\/(.+))?$/) ?? []
    if (threadId && part === undefined) return Response.json(thread(threadId))
    if (threadId && part === "messages" && method === "POST") {
      posted.push((await request.json()) as Record<string, unknown>)
      return Response.json(
        {
          run: {
            id: `run_${posted.length}`,
            projectId: "proj",
            threadId,
            triggerMessageId: `msg_${posted.length}`,
            status: "queued",
            attempt: 0,
            streamId: `stream_${posted.length}`,
            requestedBy: dana,
            createdAt: at,
          },
        },
        { status: 202 }
      )
    }
    if (threadId && part === "messages") {
      return Response.json({ messages: [], authors: [], hasMore: false, total: 0 })
    }
    if (threadId && part === "runs") return Response.json({ runs: [], hasMore: false, total: 0 })
    if (path === "/api/object-types") return Response.json([])

    return Response.json({ error: "Not found" }, { status: 404 })
  }
}

function renderChat(
  options: {
    readonly threadId?: string | null
    readonly language?: readonly LanguageModel[]
    readonly routing?: boolean
  } = {}
) {
  const posted: Posted = []
  const language = options.language ?? tiers
  const routing = options.routing ?? (options.language ? undefined : true)
  client.setConfig({
    fetch: Object.assign(api(language, routing, posted), {
      preconnect: fetch.preconnect,
    }),
  })

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(getAuthSessionQueryKey(), {
    authenticated: true,
    user: { id: dana.id, email: "dana@acme.test", displayName: "Dana Reyes", groupIds: [] },
    session: { id: "ses_1", expiresAt: "2026-12-01T00:00:00.000Z" },
  })

  const chat = (threadId: string | null) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AgentChat threadId={threadId} onNavigateHome={() => {}} onNavigateThread={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>
  )
  const view = render(chat(options.threadId === undefined ? "thr_1" : options.threadId))
  return { view, posted, open: (threadId: string | null) => view.rerender(chat(threadId)) }
}

const PINS_KEY = "sixb.agent-ui.model-pins"
const storedPins = () => JSON.parse(browser.localStorage.getItem(PINS_KEY) ?? "{}")

/**
 * React DOM was imported before Happy DOM, so it sees typing through its fallback: a keyup in the
 * field that has focus.
 */
async function send(view: ReturnType<typeof render>, posted: Posted, text: string) {
  const input = view.getByRole("textbox", { name: "Message" })
  fireEvent.focusIn(input)
  fireEvent.input(input, { target: { value: text } })
  fireEvent.keyUp(input, { key: text.at(-1) })
  const count = posted.length
  fireEvent.keyDown(input, { key: "Enter" })
  await waitFor(() => expect(posted).toHaveLength(count + 1))

  return posted[count]
}

async function pin(view: ReturnType<typeof render>, name: string) {
  fireEvent.click(await view.findByRole("button", { name: "Model: Auto. Change it" }))
  const menu = within(await view.findByRole("radiogroup", { name: "Model" }))
  fireEvent.click(menu.getByRole("radio", { name: new RegExp(`^${name}`) }))
  await view.findByRole("button", { name: `Model: ${name}. Change it` })
}

describe("the model chip with tiers", () => {
  // Removal proof: drop the tiers branch from ModelControls; no Auto chip shows.
  test("starts on Auto, and a message asks for no model", async () => {
    const { view, posted } = renderChat()

    expect(await view.findByRole("button", { name: "Model: Auto. Change it" })).toBeDefined()
    expect(view.queryByRole("button", { name: "Choose model and reasoning effort" })).toBeNull()

    const body = await send(view, posted, "Which invoices are due?")
    expect(body).toMatchObject({ text: "Which invoices are due?" })
    expect(body).not.toHaveProperty("model")
    expect(body).not.toHaveProperty("reasoning")
  })

  // Removal proof: return Auto from resolveModelSelection whatever the preference, as #890 did;
  // the chip stays on Auto and the message asks for nothing.
  test("lists Auto then each tier, and a model chosen in it is pinned with its reasoning", async () => {
    const { view, posted } = renderChat()
    fireEvent.click(await view.findByRole("button", { name: "Model: Auto. Change it" }))

    const menu = within(await view.findByRole("radiogroup", { name: "Model" }))
    expect(menu.getAllByRole("radio").map((radio) => radio.textContent)).toEqual([
      "AutoPicks the right model for each message",
      // One model a tier: each name carries its tier, and its radio is described by it. Just
      // names: a catalog description is a paragraph, kept for the details card.
      "FlashFast",
      "SonnetBalanced",
      "OpusThorough",
    ])
    expect(menu.getByRole("radio", { name: /^Auto/ }).getAttribute("aria-checked")).toBe("true")
    expect(menu.getByText("Fast")).toBeDefined()
    expect(menu.getByText("Thorough")).toBeDefined()
    // The reasoning belongs to a pinned model: Auto has none.
    expect(view.queryByText("Thinking")).toBeNull()

    fireEvent.click(menu.getByRole("radio", { name: /^Opus/ }))

    await view.findByRole("button", { name: "Model: Opus. Change it" })
    expect(menu.getByRole("radio", { name: /^Opus/ }).getAttribute("aria-checked")).toBe("true")
    expect(view.getByText("Thinking")).toBeDefined()

    const body = await send(view, posted, "Compare Q3 spend with Q2")
    expect(body).toMatchObject({ model: { provider: "gateway", modelId: opus.modelId } })
  })

  // Removal proof: make `chooseAuto` a no-op; the chip keeps Opus and the message asks for it.
  test("choosing Auto in the menu unpins the model", async () => {
    const { view, posted } = renderChat()
    await pin(view, "Opus")

    // The menu stays open on a pinned model, for its thinking.
    const menu = within(await view.findByRole("radiogroup", { name: "Model" }))
    fireEvent.click(menu.getByRole("radio", { name: /^Auto/ }))

    await view.findByRole("button", { name: "Model: Auto. Change it" })
    expect(await send(view, posted, "And now?")).not.toHaveProperty("model")
  })

  // Removal proof: make writeModelPins a no-op, the reloaded chat is on Auto; key the pin by a
  // constant instead of the thread, the other thread shows Opus too.
  test("a pin survives a reload, in its own thread only", async () => {
    const first = renderChat()
    await pin(first.view, "Opus")
    first.view.unmount()

    const reloaded = renderChat()
    expect(
      await reloaded.view.findByRole("button", { name: "Model: Opus. Change it" })
    ).toBeDefined()
    reloaded.view.unmount()

    const other = renderChat({ threadId: "thr_2" })
    expect(await other.view.findByRole("button", { name: "Model: Auto. Change it" })).toBeDefined()
  })

  // Removal proof: drop pinModel from showCreatedThread; the new thread's pin is lost.
  test("a model pinned in a new conversation stays pinned in the thread it creates", async () => {
    const { view, posted } = renderChat({ threadId: null })
    await pin(view, "Flash")

    const body = await send(view, posted, "Who is owed the most?")
    expect(body).toMatchObject({ model: { modelId: flash.modelId } })
    await waitFor(() =>
      expect(storedPins()).toEqual({
        thr_new: { model: { provider: "gateway", modelId: flash.modelId } },
      })
    )
  })

  // Removal proof: drop the effect that clears newThreadPin; the next new conversation is on Flash.
  test("a model pinned in a new conversation is not pinned in the next one", async () => {
    const { view, open } = renderChat({ threadId: null })
    await pin(view, "Flash")

    open("thr_1")
    await view.findByRole("button", { name: "Model: Auto. Change it" })
    open(null)

    expect(await view.findByRole("button", { name: "Model: Auto. Change it" })).toBeDefined()
    expect(storedPins()).toEqual({})
  })

  // Removal proof: write from the pins in memory instead of the stored ones, thr_2's pin is lost;
  // drop the storage listener, the chip misses the other tab's pin.
  test("pins from another tab are kept, and followed", async () => {
    const { view } = renderChat()
    await view.findByRole("button", { name: "Model: Auto. Change it" })

    const opusPin = { model: { provider: "gateway", modelId: opus.modelId } }
    browser.localStorage.setItem(PINS_KEY, JSON.stringify({ thr_2: opusPin }))
    await pin(view, "Flash")
    expect(Object.keys(storedPins())).toEqual(["thr_2", "thr_1"])

    browser.localStorage.setItem(PINS_KEY, JSON.stringify({ thr_1: opusPin }))
    act(() => {
      window.dispatchEvent(
        new browser.StorageEvent("storage", { key: PINS_KEY }) as unknown as Event
      )
    })
    expect(await view.findByRole("button", { name: "Model: Opus. Change it" })).toBeDefined()
  })

  // Removal proof: only call onChooseAuto with a model pinned; the stale pin stays stored.
  test("Auto clears a pin whose model left the catalog", async () => {
    browser.localStorage.setItem(
      PINS_KEY,
      JSON.stringify({ thr_1: { model: { provider: "gateway", modelId: "gone" } } })
    )
    const { view } = renderChat()

    fireEvent.click(await view.findByRole("button", { name: "Model: Auto. Change it" }))
    const menu = within(await view.findByRole("radiogroup", { name: "Model" }))
    fireEvent.click(menu.getByRole("radio", { name: /^Auto/ }))

    await waitFor(() => expect(storedPins()).toEqual({}))
  })

  // Removal proof: always describe Auto as routing; without a decision model it names none.
  test("says what Auto runs without a decision model", async () => {
    const { view } = renderChat({ routing: false })
    fireEvent.click(await view.findByRole("button", { name: "Model: Auto. Change it" }))

    const menu = within(await view.findByRole("radiogroup", { name: "Model" }))
    expect(menu.getByRole("radio", { name: /^Auto/ }).textContent).toBe("AutoSixb uses Sonnet")
  })

  // Removal proof: drop the Drawer branch from AutoModelChip; the menu opens in a popover.
  test("on a phone, the menu opens as a bottom sheet", async () => {
    browser.happyDOM.setViewport({ width: 375, height: 812 })
    const { view } = renderChat()

    fireEvent.click(await view.findByRole("button", { name: "Model: Auto. Change it" }))

    const sheet = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-slot=drawer-content]")
      if (!found) throw new Error("No bottom sheet.")
      return found
    })
    expect(within(sheet).getByRole("radio", { name: /^Opus/ })).toBeDefined()
    expect(document.querySelector("[data-slot=popover-content]")).toBeNull()
  })
})

describe("the model picker with a list", () => {
  // Removal proof: take the tiers branch of ModelControls whatever the catalog; the list shows Auto.
  test("is unchanged: the default model, and no Auto", async () => {
    const { view } = renderChat({ language: list })

    const picker = await view.findByRole("button", { name: "Choose model and reasoning effort" })
    await waitFor(() => expect(picker.textContent).toContain("Sonnet"))
    expect(view.queryByRole("button", { name: "Model: Auto. Change it" })).toBeNull()
  })
})
