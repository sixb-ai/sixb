import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { client, type GetAuthProfileResponse, type GetAuthSessionResponse } from "@sixb/client"
import {
  getAgentOptions,
  getAgentPreferencesQueryKey,
  getAuthAccessManagementOptionsQueryKey,
  getAuthProfileQueryKey,
  getAuthSessionQueryKey,
  listAuthSessionsQueryKey,
} from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { readRunSound } from "../src/agent/run-sounds"
import { SectionsProvider, SettingsPersonalPage } from "../src/pages"
import { notify } from "../src/pages/section-page"
import { PersonAvatar } from "../src/pages/settings/controls"
import { installDom } from "./helpers/dom"
import { stubWebSockets } from "./helpers/offline-sockets"

installDom([
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLFormElement",
  "FormData",
  "Event",
  "EventTarget",
  "MouseEvent",
  "KeyboardEvent",
  "MutationObserver",
  "getComputedStyle",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "localStorage",
])
const apiUrl = "https://api.sixb.test"
const originalConfig = client.getConfig()
let sockets: ReturnType<typeof stubWebSockets> | undefined
// Generated query keys carry the client's base URL, so it is set before any key is built.
client.setConfig({ baseUrl: apiUrl })

beforeAll(() => {
  sockets = stubWebSockets()
})

afterEach(() => {
  client.setConfig({ fetch: originalConfig.fetch })
})

afterAll(() => {
  client.setConfig({ baseUrl: originalConfig.baseUrl })
  sockets?.restore()
})

function sessionNamed(displayName: string): GetAuthSessionResponse {
  return {
    authenticated: true,
    user: { id: "user-1", email: "morgan@example.com", displayName, groupIds: [] },
    session: { id: "session-1", expiresAt: "2026-10-15T00:00:00.000Z" },
  }
}

function profileOf(
  displayName: string,
  managedFields: GetAuthProfileResponse["managedFields"] = []
): GetAuthProfileResponse {
  return {
    profile: { id: "user-1", email: "morgan@example.com", displayName, status: "active" },
    managedFields,
  }
}

function renderPersonal(
  profile?: GetAuthProfileResponse,
  agent?: { readonly approvalMode: "manual" | "accept-edits" | "auto" }
) {
  // Cached answers never go stale, so the page only fetches what a test changes.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  })
  queryClient.setQueryData(getAuthSessionQueryKey(), sessionNamed("Morgan Reyes"))
  if (profile) queryClient.setQueryData(getAuthProfileQueryKey(), profile)
  queryClient.setQueryData(getAuthAccessManagementOptionsQueryKey(), { groups: [] })
  queryClient.setQueryData(listAuthSessionsQueryKey(), { sessions: [] })
  if (agent) {
    queryClient.setQueryData(getAgentOptions().queryKey, {
      name: "Sixb",
      model: { provider: "test", modelId: "test-model" },
    })
    queryClient.setQueryData(getAgentPreferencesQueryKey(), {
      approvalMode: agent.approvalMode,
      approvalModeSource: "fallback",
    })
  } else {
    // Without an agent, the page has no approval mode to offer. The server answers with a 404,
    // which a seeded query cannot hold, so `null` goes in under the key without its data type.
    queryClient.setQueryData([...getAgentOptions().queryKey], null)
  }

  return render(
    <QueryClientProvider client={queryClient}>
      <SectionsProvider visibility={undefined}>
        <MemoryRouter initialEntries={["/settings/personal"]}>
          <SettingsPersonalPage />
        </MemoryRouter>
      </SectionsProvider>
    </QueryClientProvider>
  )
}

function answerWith(answer: (request: Request) => Response | Promise<Response>) {
  const api = async (input: RequestInfo | URL, init?: RequestInit) =>
    answer(new Request(input, init))
  client.setConfig({ fetch: Object.assign(api, { preconnect: fetch.preconnect }) })
}

describe("your name on Settings › Personal", () => {
  test("you rename yourself in place", async () => {
    const sent: unknown[] = []
    answerWith(async (request) => {
      if (request.method === "PATCH") {
        sent.push(await request.json())
        return Response.json(profileOf("Morgan R."))
      }
      return Response.json(sessionNamed("Morgan R."))
    })
    const view = renderPersonal(profileOf("Morgan Reyes"))

    fireEvent.click(view.getByRole("button", { name: "Edit your name" }))
    const input = view.getByRole("textbox", { name: "Name" }) as HTMLInputElement
    expect(input.value).toBe("Morgan Reyes")
    fireEvent.input(input, { target: { value: "Morgan R." } })
    fireEvent.click(view.getByRole("button", { name: "Save" }))

    expect(await view.findByText("Morgan R.")).toBeDefined()
    expect(sent).toEqual([{ displayName: "Morgan R." }])
    expect(view.queryByRole("textbox", { name: "Name" })).toBeNull()
  })

  // Regression proof: drop the effect that refocuses the edit button and both checks fail.
  test("cancelling keeps the name you had, and gives focus back to the edit button", () => {
    const view = renderPersonal(profileOf("Morgan Reyes"))

    fireEvent.click(view.getByRole("button", { name: "Edit your name" }))
    fireEvent.input(view.getByRole("textbox", { name: "Name" }), { target: { value: "M" } })
    fireEvent.click(view.getByRole("button", { name: "Cancel" }))

    expect(view.getByText("Morgan Reyes")).toBeDefined()
    expect(view.queryByRole("textbox", { name: "Name" })).toBeNull()
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Edit your name" }))

    fireEvent.click(view.getByRole("button", { name: "Edit your name" }))
    fireEvent.keyDown(view.getByRole("textbox", { name: "Name" }), { key: "Escape" })
    expect(view.queryByRole("textbox", { name: "Name" })).toBeNull()
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Edit your name" }))
  })

  test("a refused name keeps the form open and says why", async () => {
    const refused = "[Sixb] A display name can be at most 100 characters."
    answerWith(() => Response.json({ error: refused }, { status: 400 }))
    const errors = spyOn(notify, "error")
    const view = renderPersonal(profileOf("Morgan Reyes"))

    try {
      fireEvent.click(view.getByRole("button", { name: "Edit your name" }))
      fireEvent.click(view.getByRole("button", { name: "Save" }))

      await waitFor(() => expect(errors).toHaveBeenCalledWith(refused))
      expect(view.getByRole("textbox", { name: "Name" })).toBeDefined()
    } finally {
      errors.mockRestore()
    }
  })

  // Regression proof: drop `!nameManaged` from nameEditable and the edit button shows.
  test("a name your identity provider sets stays read-only, and says where it comes from", () => {
    const view = renderPersonal(profileOf("Morgan Reyes", ["displayName"]))

    expect(view.getByText("Morgan Reyes")).toBeDefined()
    expect(view.queryByRole("button", { name: "Edit your name" })).toBeNull()
    expect(view.getByText(/Your name comes from your identity provider/)).toBeDefined()
  })

  test("waits for the profile before offering to edit", () => {
    answerWith(() => new Promise<Response>(() => {}))
    const view = renderPersonal()

    expect(view.getByText("Morgan Reyes")).toBeDefined()
    expect(view.queryByRole("button", { name: "Edit your name" })).toBeNull()
  })
})

// Regression proof: drop the img's onError and the initials never show.
test("an avatar that does not load shows the initials", () => {
  const view = render(
    <PersonAvatar
      name="Morgan Reyes"
      email="morgan@example.com"
      avatarUrl="https://images.example.com/missing.png"
    />
  )

  const image = view.container.querySelector("img")
  expect(image).not.toBeNull()
  if (image) {
    fireEvent.error(image)
  }

  expect(view.container.querySelector("img")).toBeNull()
  expect(view.getByText("MR")).toBeDefined()
})

describe("what the agent may change, on Settings › Personal", () => {
  // Removal proof: drop ApprovalModeSection from the page; the radios are gone.
  test("you choose your default, and it saves at once", async () => {
    const sent: unknown[] = []
    answerWith(async (request) => {
      sent.push(await request.json())
      return Response.json({ approvalMode: "auto", approvalModeSource: "default" })
    })
    const view = renderPersonal(profileOf("Morgan Reyes"), { approvalMode: "manual" })

    const group = view.getByRole("radiogroup", { name: "When the agent changes things" })
    expect(view.getByRole("radio", { name: /^Ask first/ }).getAttribute("aria-checked")).toBe(
      "true"
    )
    expect(group).toBeDefined()

    fireEvent.click(view.getByRole("radio", { name: /^Full access/ }))

    await waitFor(() =>
      expect(view.getByRole("radio", { name: /^Full access/ }).getAttribute("aria-checked")).toBe(
        "true"
      )
    )
    expect(sent).toEqual([{ approvalMode: "auto" }])
  })

  // Removal proof: drop `moveRadioFocus` from the group's onKeyDown; the arrow saves nothing.
  test("the arrow keys move through the modes, as in any radio group", async () => {
    const sent: unknown[] = []
    answerWith(async (request) => {
      sent.push(await request.json())
      return Response.json({ approvalMode: "accept-edits", approvalModeSource: "default" })
    })
    const view = renderPersonal(profileOf("Morgan Reyes"), { approvalMode: "manual" })
    const manual = view.getByRole("radio", { name: /^Ask first/ })
    expect(manual.getAttribute("tabindex")).toBe("0")
    expect(view.getByRole("radio", { name: /^Full access/ }).getAttribute("tabindex")).toBe("-1")

    manual.focus()
    fireEvent.keyDown(manual, { key: "ArrowDown" })

    await waitFor(() => expect(sent).toEqual([{ approvalMode: "accept-edits" }]))
    expect(document.activeElement).toBe(view.getByRole("radio", { name: /^Allow edits/ }))
  })

  test("is not offered in a project without an agent", () => {
    const view = renderPersonal(profileOf("Morgan Reyes"))

    expect(view.queryByRole("radiogroup", { name: "When the agent changes things" })).toBeNull()
  })
})

describe("sounds, on Settings › Personal", () => {
  afterEach(() => localStorage.clear())

  // Removal proof: drop writeRunSound from choose(); the choice is not kept.
  test("you choose the sound this browser plays, or none", () => {
    const view = renderPersonal(profileOf("Morgan Reyes"), { approvalMode: "manual" })
    view.getByRole("radiogroup", { name: "Notification sound" })
    expect(view.getByRole("radio", { name: "Chime" }).getAttribute("aria-checked")).toBe("true")

    fireEvent.click(view.getByRole("radio", { name: "Bell" }))
    expect(view.getByRole("radio", { name: "Bell" }).getAttribute("aria-checked")).toBe("true")
    expect(readRunSound()).toBe("bell")

    fireEvent.click(view.getByRole("radio", { name: "Off" }))
    expect(readRunSound()).toBe("off")
  })

  test("is not offered in a project without an agent", () => {
    const view = renderPersonal(profileOf("Morgan Reyes"))

    expect(view.queryByRole("radiogroup", { name: "Notification sound" })).toBeNull()
  })
})
