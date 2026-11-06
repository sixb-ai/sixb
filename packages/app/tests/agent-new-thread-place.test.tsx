import { afterEach, describe, expect, test } from "bun:test"
import { client } from "@sixb/client"
import { type DesktopComputerAccess, listAgentComputersQueryKey } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { Composer, type ComposerProps } from "../src/agent/components/composer"
import { ComputerOfflineNotice } from "../src/agent/components/computer-place"
import {
  ComputerUnavailableError,
  useNewThreadPlace,
} from "../src/agent/hooks/use-new-thread-place"
import { installDom } from "./helpers/dom"

installDom([
  "document",
  "navigator",
  "localStorage",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Event",
  "CustomEvent",
  "EventTarget",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "PointerEvent",
  "MutationObserver",
  "ResizeObserver",
  "getComputedStyle",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

const COMPUTER = { id: "cmp_1", name: "Ava's Mac" }

/** A desktop app around the page, as useDesktop reads it, whose person answers with `picked`. */
function desktopApp(picked: readonly (string | null)[] = [], folders: readonly string[] = []) {
  const answers = [...picked]
  let allowed = [...folders]
  let asked = 0
  const computer: DesktopComputerAccess = {
    about: async () => COMPUTER,
    folders: async () => allowed,
    pickFolder: async () => {
      asked += 1
      const answer = answers.shift() ?? null
      if (answer) allowed = [...allowed, answer]
      return answer
    },
    allowFolder: async () => true,
    forgetFolder: async (folder) => {
      allowed = allowed.filter((known) => known !== folder)
    },
  }
  Object.assign(globalThis, { sixbDesktop: { platform: "darwin", computer } })
  return { asked: () => asked }
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete (globalThis as { sixbDesktop?: unknown }).sixbDesktop
  client.setConfig({ baseUrl: undefined, fetch: undefined })
})

/** The project API, answering the person's computers with sixb open as `listed` says now. */
function api(listed: () => Response | Promise<Response>) {
  const fetchMock = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = input instanceof Request && !init ? input : new Request(input, init)
      if (new URL(request.url).pathname === "/api/agent-computers") return listed()
      return Response.json({ error: "Not found" }, { status: 404 })
    },
    { preconnect: fetch.preconnect }
  ) satisfies typeof fetch
  client.setConfig({ baseUrl: "http://localhost", fetch: fetchMock })
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

function renderPlace(starting = true) {
  queryClient.clear()
  return renderHook(() => useNewThreadPlace(starting), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  })
}

async function placeHook() {
  const hook = renderPlace()
  await waitFor(() => expect(hook.result.current.place).not.toBeNull())
  return hook
}

/** This computer, as the desktop app's place lists it. */
const here = (hook: { current: ReturnType<typeof useNewThreadPlace> }) => {
  const computer = hook.current.place?.computers[0]
  if (!computer) throw new Error("No computer to choose a folder on.")
  return computer
}

describe("where a new conversation runs", () => {
  // Guard proof: answer {} when pickFolder returns null, in resolveBody; cancelling the dialog sends
  // the message to the cloud, which the person didn't choose.
  test("asks for a folder at the first message, and sends nothing if they cancel", async () => {
    const app = desktopApp([null, "/work/notes"])
    const { result } = await placeHook()

    const answers: unknown[] = []
    await act(async () => {
      answers.push(await result.current.resolveBody())
    })
    expect(answers).toEqual([null])
    expect(app.asked()).toBe(1)

    await act(async () => {
      answers.push(await result.current.resolveBody())
    })
    expect(answers.at(-1)).toEqual({
      runsOn: "computer",
      computer: { ...COMPUTER, folder: "/work/notes" },
    })
  })

  // Guard proof: leave `remember` out of pick; every new conversation asks for a folder again.
  test("starts later conversations in the last folder, without asking", async () => {
    const app = desktopApp(["/work/notes"])
    const first = await placeHook()
    await act(async () => {
      await first.result.current.resolveBody()
    })
    first.unmount()

    const { result } = await placeHook()
    expect(result.current.place?.chosen?.folder ?? null).toBe("/work/notes")
    expect(await result.current.resolveBody()).toEqual({
      runsOn: "computer",
      computer: { ...COMPUTER, folder: "/work/notes" },
    })
    expect(app.asked()).toBe(1)
  })

  // Guard proof: use the stored folder without asking the runner, in resolveBody; after a sign-in
  // ends, or `sixb` forgets the folder, the message waits with nothing to tell the person why.
  test("asks again for a folder that's no longer allowed here", async () => {
    localStorage.setItem(
      "sixb.agent.new-thread-place",
      JSON.stringify({ cloud: false, folder: "/work/gone" })
    )
    const app = desktopApp(["/work/notes"])
    const { result } = await placeHook()
    await waitFor(() => expect(result.current.place?.chosen?.folder ?? null).toBeNull())

    let body: unknown
    await act(async () => {
      body = await result.current.resolveBody()
    })

    expect(app.asked()).toBe(1)
    expect(body).toEqual({ runsOn: "computer", computer: { ...COMPUTER, folder: "/work/notes" } })
  })

  // Guard proof: answer {} while `computer` is null, as the hook first did; a message sent as the app
  // opens goes to the cloud, whatever the person chose.
  test("waits for the runner, rather than sending the first message to the cloud", async () => {
    localStorage.setItem(
      "sixb.agent.new-thread-place",
      JSON.stringify({ cloud: false, folder: "/work/notes" })
    )
    let say = (_about: typeof COMPUTER) => {}
    const computer: DesktopComputerAccess = {
      about: () =>
        new Promise((resolve) => {
          say = resolve
        }),
      folders: async () => ["/work/notes"],
      pickFolder: async () => null,
      allowFolder: async () => true,
      forgetFolder: async () => {},
    }
    Object.assign(globalThis, { sixbDesktop: { platform: "darwin", computer } })
    const { result } = renderPlace()
    expect(result.current.place).toBeNull()

    const body = result.current.resolveBody()
    await act(async () => {
      say(COMPUTER)
    })
    expect(await body).toEqual({
      runsOn: "computer",
      computer: { ...COMPUTER, folder: "/work/notes" },
    })
  })

  // Guard proof: read `about` only once, dropping the focus listener; a runner slow to start the first
  // time leaves the app with no choice of place until it's restarted.
  test("offers the choice once a runner that couldn't start has", async () => {
    let answer: typeof COMPUTER | null = null
    const computer: DesktopComputerAccess = {
      about: async () => answer,
      folders: async () => [],
      pickFolder: async () => null,
      allowFolder: async () => true,
      forgetFolder: async () => {},
    }
    Object.assign(globalThis, { sixbDesktop: { platform: "darwin", computer } })
    const { result } = renderPlace()
    await act(async () => {})
    expect(result.current.place).toBeNull()

    answer = COMPUTER
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
    })
    await waitFor(() => expect(result.current.place).not.toBeNull())
  })

  // Guard proof: answer {} when about rejects, as an answer of null does; a message goes to the cloud
  // past the folder the person chose. Or keep the place null until it answers: with the runner down,
  // nothing lets them choose the cloud.
  test("says so when what runs it can't start, with the cloud still a choice", async () => {
    localStorage.setItem(
      "sixb.agent.new-thread-place",
      JSON.stringify({ cloud: false, folder: "/work/notes" })
    )
    let starts = false
    const computer: DesktopComputerAccess = {
      about: async () => {
        if (!starts) throw new Error("It couldn't start.")
        return COMPUTER
      },
      folders: async () => ["/work/notes"],
      pickFolder: async () => null,
      allowFolder: async () => true,
      forgetFolder: async () => {},
    }
    Object.assign(globalThis, { sixbDesktop: { platform: "darwin", computer } })
    const { result } = renderPlace()
    await waitFor(() => expect(result.current.place).not.toBeNull())
    expect(result.current.place?.computers[0]?.name).toBeNull()

    const refused = await result.current.resolveBody().catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(ComputerUnavailableError)

    act(() => result.current.place?.chooseCloud())
    expect(await result.current.resolveBody()).toEqual({})
    act(() => result.current.place?.chooseFolder(here(result), "/work/notes"))

    starts = true
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
    })
    await waitFor(() => expect(result.current.place?.computers[0]?.name).toBe(COMPUTER.name))
    expect(await result.current.resolveBody()).toEqual({
      runsOn: "computer",
      computer: { ...COMPUTER, folder: "/work/notes" },
    })
  })

  test("is the cloud once chosen, until a folder is", async () => {
    desktopApp([], ["/work/notes"])
    const { result } = await placeHook()

    act(() => result.current.place?.chooseCloud())
    expect(await result.current.resolveBody()).toEqual({})

    act(() => result.current.place?.chooseFolder(here(result), "/work/notes"))
    expect(await result.current.resolveBody()).toEqual({
      runsOn: "computer",
      computer: { ...COMPUTER, folder: "/work/notes" },
    })
  })

  // Guard proof: leave the stored folder as it is in forgetFolder; the next message goes on using a
  // folder the person just took back.
  test("asks again after the folder in use is forgotten", async () => {
    const app = desktopApp(["/work/notes", "/work/books"])
    const { result } = await placeHook()
    await act(async () => {
      await result.current.resolveBody()
    })

    act(() => result.current.place?.forgetFolder?.("/work/notes"))
    await act(async () => {
      await result.current.resolveBody()
    })

    expect(app.asked()).toBe(2)
    expect(result.current.place?.chosen?.folder ?? null).toBe("/work/books")
  })
})

describe("where a new conversation runs, in a browser", () => {
  const LAPTOP = { id: "laptop", name: "Ava's MacBook Pro", folders: ["/work/notes", "/work/q3"] }
  const IMAC = { id: "imac", name: "Ava's iMac", folders: ["/work/notes"] }

  test("is the cloud, with no choice, while sixb is open on none of the person's computers", async () => {
    let asked = 0
    api(() => {
      asked += 1
      return Response.json({ computers: [] })
    })
    const { result } = renderPlace()
    await waitFor(() => expect(asked).toBe(1))

    expect(result.current.place).toBeNull()
    expect(await result.current.resolveBody()).toEqual({})
  })

  // Guard proof: leave the list query disabled in a browser; a person with sixb open on their Mac
  // has no way to start a conversation there from the web.
  test("offers the folders sixb is open in, on each computer, with the cloud first chosen", async () => {
    api(() => Response.json({ computers: [IMAC, LAPTOP] }))
    const { result } = await placeHook()

    expect(result.current.place?.computers).toEqual([IMAC, LAPTOP])
    expect(result.current.place?.cloud).toBe(true)
    expect(result.current.place?.pickFolder).toBeUndefined()
    expect(result.current.place?.forgetFolder).toBeUndefined()
    expect(await result.current.resolveBody()).toEqual({})

    const laptop = result.current.place?.computers[1]
    if (!laptop) throw new Error("No laptop listed.")
    act(() => result.current.place?.chooseFolder(laptop, "/work/q3"))
    expect(result.current.place?.chosen).toEqual({ computer: LAPTOP, folder: "/work/q3" })
    expect(await result.current.resolveBody()).toEqual({
      runsOn: "computer",
      computer: { id: "laptop", name: "Ava's MacBook Pro", folder: "/work/q3" },
    })
  })

  // Guard proof: send the stored folder in resolveBody without checking the list; with sixb closed
  // there, the message waits on a computer while the composer showed the cloud.
  test("is the cloud while the folder chosen last isn't open, and the folder again once it is", async () => {
    localStorage.setItem(
      "sixb.agent.new-thread-place.online",
      JSON.stringify({ computerId: "laptop", folder: "/work/q3" })
    )
    let computers = [IMAC]
    api(() => Response.json({ computers }))
    const { result } = await placeHook()

    expect(result.current.place?.cloud).toBe(true)
    expect(await result.current.resolveBody()).toEqual({})

    // sixb opened there: the activity feed's computer event marks the list stale, as the
    // conversation hook does.
    computers = [IMAC, LAPTOP]
    await act(() => queryClient.invalidateQueries({ queryKey: listAgentComputersQueryKey() }))
    await waitFor(() => expect(result.current.place?.cloud).toBe(false))
    expect(result.current.place?.chosen?.folder).toBe("/work/q3")
    expect(await result.current.resolveBody()).toMatchObject({ runsOn: "computer" })
  })

  // Guard proof: enable the list query whatever `starting` says; every open conversation in a
  // browser reads the person's computers for a menu it never shows.
  test("lists nothing while a conversation is open", () => {
    api(() => Response.json({ computers: [LAPTOP] }))
    renderPlace(false)

    // An enabled query is fetching as soon as it mounts.
    expect(queryClient.getQueryState(listAgentComputersQueryKey())?.fetchStatus ?? "idle").toBe(
      "idle"
    )
  })

  // Guard proof: read the list's current data in resolveBody instead of ensureQueryData; a message
  // sent as the page opens goes to the cloud, past the folder the person chose.
  test("waits for the list, rather than sending the first message to the cloud", async () => {
    localStorage.setItem(
      "sixb.agent.new-thread-place.online",
      JSON.stringify({ computerId: "laptop", folder: "/work/q3" })
    )
    let answer = (_response: Response) => {}
    let asked = false
    api(
      () =>
        new Promise<Response>((resolve) => {
          asked = true
          answer = resolve
        })
    )
    const { result } = renderPlace()
    expect(result.current.place).toBeNull()

    const body = result.current.resolveBody()
    await waitFor(() => expect(asked).toBe(true))
    await act(async () => {
      answer(Response.json({ computers: [LAPTOP] }))
    })
    expect(await body).toEqual({
      runsOn: "computer",
      computer: { id: "laptop", name: "Ava's MacBook Pro", folder: "/work/q3" },
    })
  })
})

describe("the line under the composer", () => {
  const mac = { id: "cmp_1", name: "Ava's Mac", folders: ["/Users/ava/work/notes"] }
  const place = {
    computers: [mac],
    remote: false,
    cloud: false,
    chosen: { computer: mac, folder: "/Users/ava/work/notes" },
    chooseCloud: () => {},
    chooseFolder: () => {},
    pickFolder: async () => {},
    forgetFolder: () => {},
  }

  function composer(newThreadPlace?: ComposerProps["newThreadPlace"]) {
    const client = new QueryClient()
    return render(
      <QueryClientProvider client={client}>
        <Composer onSend={() => {}} newThreadPlace={newThreadPlace} />
      </QueryClientProvider>
    )
  }

  // Guard proof: render ComposerPlace back inside the composer's surface; the input shrinks, and it
  // differs from a browser's.
  test("names the folder and its path, outside the input", () => {
    const { container } = composer(place)
    const line = container.querySelector('[data-slot="composer-place"]')

    expect(line?.textContent).toContain("notes")
    expect(line?.textContent).toContain("~/work/notes")
    expect(line?.closest(".sixb-composer-surface")).toBeNull()
  })

  // Guard proof: drop the computer's name from the chip's path when `remote`; from a browser, a
  // folder on the laptop and the same one on the iMac read alike.
  test("names the computer too, in a browser", () => {
    const { container } = composer({ ...place, remote: true })
    const line = container.querySelector('[data-slot="composer-place"]')

    expect(line?.textContent).toContain("Ava's Mac · ~/work/notes")
  })

  // Guard proof: render the line only once the place is known; a composer centered on the page jumps
  // as the runner answers.
  test("holds its height while the place isn't known, and is absent in a browser", () => {
    const waiting = composer("waiting").container
    expect(waiting.querySelector('[data-slot="composer-place"]')).not.toBeNull()
    expect(waiting.querySelector('[data-slot="composer-place"] button')).toBeNull()
    cleanup()

    expect(composer().container.querySelector('[data-slot="composer-place"]')).toBeNull()
  })
})

describe("a conversation waiting for its computer", () => {
  const computer = { id: "cmp_1", name: "Ava's Mac", folder: "/work/notes", online: false }
  const notice = { computer, pending: false, error: null, onContinueInCloud: () => {} }

  // Guard proof: show the button with or without onRunHere; a browser offers to run on a computer it
  // isn't on, and clicking does nothing.
  test("offers to run here only on its own computer", () => {
    let asked = 0
    const { rerender, queryByRole, getByRole } = render(<ComputerOfflineNotice {...notice} />)
    expect(queryByRole("button", { name: "Run on this computer" })).toBeNull()

    rerender(<ComputerOfflineNotice {...notice} onRunHere={() => (asked += 1)} />)
    fireEvent.click(getByRole("button", { name: "Run on this computer" }))
    expect(asked).toBe(1)
  })
})
