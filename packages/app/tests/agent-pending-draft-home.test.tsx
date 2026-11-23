import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test"
import { client } from "@sixb/client"
import { getAuthSessionQueryKey, getProjectInfoQueryKey } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, waitFor } from "@testing-library/react"
import { type ReactNode, useLayoutEffect } from "react"
import { MemoryRouter } from "react-router-dom"
import { ArtifactPanelRoot, Composer, useAgentConversation } from "../src"
import { AgentChat } from "../src/agent/agent-chat"
import { keepAgentDraft } from "../src/artifacts/view-context"
import { installDom } from "./helpers/dom"

// Comments sent to the Agent from an artifact's own page wait in the tab, then start the input of
// the conversation Home draws: the built-in chat's, or a composer an app draws itself from
// `useAgentConversation`, as an app whose Agent lives on its own route does.

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
  "sessionStorage",
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

// Radix picks its layout effect when it loads, a no-op without a `document`; see
// agent-model-auto.test.tsx.
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
  browser.sessionStorage.clear()
})

afterAll(() => {
  mock.module(layoutEffect, () => ({ useLayoutEffect: loaded }))
  client.setConfig({ baseUrl: originalConfig.baseUrl })
  if (previousWebSocket) Object.defineProperty(globalThis, "WebSocket", previousWebSocket)
  else Reflect.deleteProperty(globalThis, "WebSocket")
})

const dana = { id: "usr_dana", email: "dana@northline.test", displayName: "Dana Reyes" }

const comments = {
  kind: "app-state" as const,
  id: "artifact-comments:art_film",
  label: "1 comment · Boiler retrofit film",
  description: "Comments the person chose on the artifact.",
  value: {
    artifactId: "art_film",
    comments: [
      { id: "cmt_1", quote: "[intro · 0:04] Warmer title", body: "Warmer title", replies: [] },
    ],
  },
}

/** The API a conversation's first load asks, answering an empty project. */
async function api(input: RequestInfo | URL, init?: RequestInit) {
  const path = new URL(new Request(input, init).url).pathname
  if (path === "/api/agent") {
    return Response.json({ name: "Sixb", model: { provider: "gateway", modelId: "sonnet" } })
  }
  if (path === "/api/models") {
    return Response.json({
      language: [],
      image: [],
      audio: { speech: [], transcription: [] },
      capabilities: { run: false },
    })
  }
  if (path === "/api/agent/preferences") {
    return Response.json({ approvalMode: "manual", approvalModeSource: "fallback" })
  }
  if (path === "/api/agent-approvals") {
    return Response.json({ approvals: [], hasMore: false, total: 0 })
  }
  if (path === "/api/agent-threads") return Response.json({ threads: [], hasMore: false, total: 0 })
  return Response.json({ error: "Not found" }, { status: 404 })
}

/** Home, as the app draws it, after Dana sent a comment to the Agent from the film's page. */
function openHome(home: ReactNode) {
  client.setConfig({ fetch: Object.assign(api, { preconnect: fetch.preconnect }) })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(getAuthSessionQueryKey(), {
    authenticated: true,
    user: { ...dana, groupIds: [] },
    session: { id: "ses_1", expiresAt: "2026-12-01T00:00:00.000Z" },
  })
  queryClient.setQueryData(getProjectInfoQueryKey(), { id: "proj", name: "Northline" } as never)
  keepAgentDraft({
    userId: dana.id,
    projectId: "proj",
    artifactId: "art_film",
    text: "Please address these comments.",
    context: comments,
  })

  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{home}</MemoryRouter>
    </QueryClientProvider>
  )
  const input = () => view.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement
  return { view, input }
}

/** A Home of the app's own, its composer drawn from the conversation, as Northline's is. */
function OwnHome() {
  const conversation = useAgentConversation({ threadId: null, onThreadCreated: () => {} })
  return (
    <ArtifactPanelRoot scopeKey="draft">
      <Composer {...conversation.composerProps} />
    </ArtifactPanelRoot>
  )
}

// Guard proof: take the kept words in AgentChat alone, as before, and give `composerProps` no
// `insertion` in useAgentConversation; Northline's Home then opens on an empty input, no chip.
test("comments sent from an artifact's page start the input of a Home the app draws itself", async () => {
  const { view, input } = openHome(<OwnHome />)

  await waitFor(() => expect(input().value).toBe("Please address these comments."))
  expect(view.getByRole("button", { name: "Show 1 comment · Boiler retrofit film" })).toBeTruthy()
  // Taken once: nothing waits for the next conversation.
  expect(browser.sessionStorage.getItem("sixb.agent.pending-draft")).toBeNull()
})

test("comments sent from an artifact's page start the built-in chat's input, once", async () => {
  const { view, input } = openHome(
    <AgentChat threadId={null} onNavigateHome={() => {}} onNavigateThread={() => {}} />
  )

  await waitFor(() => expect(input().value).toBe("Please address these comments."))
  expect(
    view.getAllByRole("button", { name: "Show 1 comment · Boiler retrofit film" })
  ).toHaveLength(1)
})
