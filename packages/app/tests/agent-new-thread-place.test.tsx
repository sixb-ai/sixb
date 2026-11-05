import { afterEach, describe, expect, test } from "bun:test"
import type { DesktopComputerAccess } from "@sixb/client/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react"
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
})

async function placeHook() {
  const hook = renderHook(() => useNewThreadPlace())
  await waitFor(() => expect(hook.result.current.place).not.toBeNull())
  return hook
}

describe("where a new conversation runs", () => {
  // Guard proof: return a place without a computer, in a browser; a conversation is created for a
  // computer nothing will ever run it on.
  test("is the cloud, with no choice, in a browser", async () => {
    const { result } = renderHook(() => useNewThreadPlace())

    expect(result.current.place).toBeNull()
    expect(await result.current.resolveBody()).toEqual({})
  })

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
    expect(result.current.place?.folder).toBe("/work/notes")
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
    await waitFor(() => expect(result.current.place?.folder).toBeNull())

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
    const { result } = renderHook(() => useNewThreadPlace())
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
    const { result } = renderHook(() => useNewThreadPlace())
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
    const { result } = renderHook(() => useNewThreadPlace())
    await waitFor(() => expect(result.current.place).not.toBeNull())
    expect(result.current.place?.computerName).toBeNull()

    const refused = await result.current.resolveBody().catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(ComputerUnavailableError)

    act(() => result.current.place?.chooseCloud())
    expect(await result.current.resolveBody()).toEqual({})
    act(() => result.current.place?.chooseFolder("/work/notes"))

    starts = true
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
    })
    await waitFor(() => expect(result.current.place?.computerName).toBe(COMPUTER.name))
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

    act(() => result.current.place?.chooseFolder("/work/notes"))
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

    act(() => result.current.place?.forgetFolder("/work/notes"))
    await act(async () => {
      await result.current.resolveBody()
    })

    expect(app.asked()).toBe(2)
    expect(result.current.place?.folder).toBe("/work/books")
  })
})

describe("the line under the composer", () => {
  const place = {
    computerName: "Ava's Mac",
    cloud: false,
    folder: "/Users/ava/work/notes",
    folders: ["/Users/ava/work/notes"],
    chooseCloud: () => {},
    chooseFolder: () => {},
    pickFolder: async () => {},
    forgetFolder: () => {},
    refreshFolders: () => {},
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
