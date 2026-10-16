import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import type { GetAuthSessionResponse } from "@sixb/client"
import { getAuthSessionQueryKey } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render } from "@testing-library/react"
import { Window } from "happy-dom"
import { useCurrentUser } from "../src/session"

const browser = new Window({ url: "https://app.sixb.test" })
const globals = [
  "window",
  "self",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Event",
  "MutationObserver",
  "IS_REACT_ACT_ENVIRONMENT",
] as const
const previous = new Map<string, PropertyDescriptor | undefined>()

beforeAll(() => {
  const values = browser as unknown as Record<string, unknown>
  for (const key of globals) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value:
        key === "window" || key === "self"
          ? browser
          : key === "IS_REACT_ACT_ENVIRONMENT"
            ? true
            : values[key],
    })
  }
})

afterEach(() => {
  cleanup()
})

afterAll(() => {
  for (const key of globals) {
    const descriptor = previous.get(key)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  browser.close()
})

const signedIn: GetAuthSessionResponse = {
  authenticated: true,
  csrfToken: "csrf",
  user: {
    id: "user-1",
    email: "alex@example.com",
    displayName: "Alex Rivera",
    groupIds: ["admins"],
  },
  session: { id: "session-1", expiresAt: "2026-10-15T00:00:00.000Z" },
}

function Who() {
  const user = useCurrentUser()
  return (
    <output data-testid="who">{user ? `${user.displayName}|${user.groupIds}` : "nobody"}</output>
  )
}

function renderWithSession(session: GetAuthSessionResponse) {
  const queryClient = new QueryClient()
  // The generated app seeds the session it loaded before the first render the same way.
  queryClient.setQueryData(getAuthSessionQueryKey(), session)
  const fetches: string[] = []
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type === "updated" && event.action.type === "fetch")
      fetches.push(event.query.queryHash)
  })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Who />
    </QueryClientProvider>
  )
  return { view, fetches }
}

// Regression proof: drop `staleTime` from useCurrentUser and the mount refetches the session.
test("useCurrentUser reads the session the app already loaded, without fetching it again", async () => {
  const { view, fetches } = renderWithSession(signedIn)
  // A stale query refetches after mounting, not during the render.
  await Bun.sleep(20)

  expect(view.getByTestId("who").textContent).toBe("Alex Rivera|admins")
  expect(fetches).toEqual([])
})

test("useCurrentUser is null when nobody is signed in", () => {
  const { view } = renderWithSession({ authenticated: false, authEnabled: false })

  expect(view.getByTestId("who").textContent).toBe("nobody")
})
