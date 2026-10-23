import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { client, encodeObjectId, type GetActionRunResponse } from "@sixb/client"
import { getAuthSessionQueryKey } from "@sixb/client/hooks"
import { LocaleProvider } from "@sixb/ui/lib/i18n"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { SectionsProvider } from "../src/pages"
import { ActionButton } from "../src/pages/ontology/components/action-button"
import { notify } from "../src/pages/section-page"
import { installDom } from "./helpers/dom"
import { stubWebSockets } from "./helpers/offline-sockets"

installDom([
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Event",
  "EventTarget",
  "MouseEvent",
  "MutationObserver",
  "getComputedStyle",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
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

function failedRun(code: "action.rejected" | "action.phase_failed", message: string) {
  return {
    id: "act_1",
    projectId: "proj",
    actionId: "close-ticket",
    subject: { kind: "object", objectTypeId: "ticket", primaryId: "t1" },
    status: "failed",
    phase: "validation",
    startedAt: "2026-10-21T12:00:00.000Z",
    finishedAt: "2026-10-21T12:00:01.000Z",
    params: {},
    error: {
      code,
      message,
      retryable: false,
      at: "2026-10-21T12:00:01.000Z",
      details: { actionId: "close-ticket", runId: "act_1", phase: "validation" },
    },
  } satisfies GetActionRunResponse
}

function answerWith(run: GetActionRunResponse) {
  const api = async () => Response.json(run)
  client.setConfig({ fetch: Object.assign(api, { preconnect: fetch.preconnect }) })
}

function renderButton(objectId: string, locale = "en") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  })
  queryClient.setQueryData(getAuthSessionQueryKey(), { authenticated: false })

  return render(
    <QueryClientProvider client={queryClient}>
      <LocaleProvider locale={locale}>
        <SectionsProvider visibility={undefined}>
          <MemoryRouter>
            <ActionButton
              objectId={objectId}
              actionId="close-ticket"
              action={{ id: "close-ticket" }}
            />
          </MemoryRouter>
        </SectionsProvider>
      </LocaleProvider>
    </QueryClientProvider>
  )
}

// Regression proof: drop `notify.error` from `showFailure` in the action button, and the button
// only turns red: every check below fails.
describe("the object page's action button", () => {
  test.each([
    [
      "a rejection, with the author's message as is",
      "action.rejected",
      "Only the assignee can close this ticket.",
    ],
    [
      "any other failure, with the run's message",
      "action.phase_failed",
      "Action execution failed.",
    ],
  ] as const)("says why it did not run: %s", async (_case, code, message) => {
    answerWith(failedRun(code, message))
    const errors = spyOn(notify, "error")

    try {
      const view = renderButton(encodeObjectId("ticket", "t1"))
      fireEvent.click(view.getByRole("button", { name: "close ticket" }))

      await waitFor(() => expect(errors).toHaveBeenCalledWith(message))
    } finally {
      errors.mockRestore()
    }
  })

  test("says in French when it cannot even request the action", () => {
    const errors = spyOn(notify, "error")

    try {
      const view = renderButton("not-an-object-id", "fr")
      fireEvent.click(view.getByRole("button", { name: "close ticket" }))

      expect(errors).toHaveBeenCalledWith(
        "L’identifiant de cet objet est invalide : not-an-object-id"
      )
    } finally {
      errors.mockRestore()
    }
  })
})
