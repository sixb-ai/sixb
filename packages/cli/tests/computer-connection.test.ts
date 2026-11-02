import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSixbClient } from "@sixb/client"
import type { Connection } from "../src/lib/connection"
import { setFoldersAllowed } from "../src/runner/allowed-folders"
import { thisComputerId } from "../src/runner/computer"
import { ComputerConnection, type ComputerEvent } from "../src/runner/computer-connection"

// A computer connected to a project, against an API that answers sessions: which folders it holds
// a session for, and how those follow the list of allowed folders.

const API = "http://api.localhost"

let home: string
let previousConfigHome: string | undefined

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "sixb-computer-connection-")))
  await mkdir(join(home, "sixb"), { recursive: true })
  previousConfigHome = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = home
})

afterEach(async () => {
  jest.useRealTimers()
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previousConfigHome
  await rm(home, { recursive: true, force: true })
})

async function folder(name: string): Promise<string> {
  const path = join(home, name)
  await mkdir(path)
  return path
}

function connected(respond: (status: number) => number = () => 200) {
  const held = new Map<string, string>()
  const answer = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const id = new URL(request.url).pathname.split("/").at(-1) ?? ""
    if (request.method === "DELETE") {
      held.delete(id)
      return new Response(null, { status: 204 })
    }
    const body = (await request.json()) as { computer: { folder: string } }
    const status = respond(200)
    if (status !== 200) return Response.json({ error: "[Test] Refused." }, { status })
    held.set(id, body.computer.folder)
    return Response.json({ expiresAt: "2026-10-31T09:01:00.000Z", waiting: [] })
  }
  const client = createSixbClient({
    baseUrl: API,
    fetch: Object.assign(answer, { preconnect: fetch.preconnect }),
  })
  const connection: Connection = {
    apiUrl: API,
    client,
    project: { id: "p", timeZone: "UTC", locale: "en" },
    user: { id: "usr_ava", email: "ava@example.test", name: "Ava" },
    authorization: async () => "",
  }
  const events: ComputerEvent[] = []
  const waiters = new Set<() => void>()
  const computer = new ComputerConnection(
    connection,
    (event) => {
      events.push(event)
      for (const wake of waiters) wake()
    },
    false
  )
  /** Until an event `matches`, without waiting on a clock. */
  const until = async (matches: (event: ComputerEvent) => boolean) => {
    while (!events.some(matches)) {
      await new Promise<void>((resolve) => {
        waiters.add(resolve)
      })
    }
  }
  return { computer, held: () => [...held.values()].sort(), events, until }
}

/** Until the sessions held read as `folders`, whose calls land after the event that caused them. */
async function holding(read: () => string[], folders: readonly string[]) {
  for (let turn = 0; turn < 200 && read().join() !== [...folders].sort().join(); turn += 1) {
    await Bun.sleep(5)
  }
  expect(read()).toEqual([...folders].sort())
}

describe("a connected computer", () => {
  // Guard proof: open a session for every folder a conversation names, or leave reconcile out of
  // start; the computer reads as online where nobody chose, or nowhere.
  test("holds a session for each allowed folder, and for no other", async () => {
    const [a, b] = await Promise.all([folder("a"), folder("b")])
    await folder("not-allowed")
    await setFoldersAllowed([a, b], true)

    const { computer, held, until } = connected()
    await computer.start()
    await until((event) => event.type === "folders")
    await holding(held, [a, b])

    await computer.stop()
    await holding(held, [])
  })

  // Guard proof: drop watchAllowedFolders from start; choosing a folder needs a restart, and
  // forgetting one leaves it running messages from the web until then.
  test("follows the list with no restart", async () => {
    const [a, b] = await Promise.all([folder("a"), folder("b")])
    await setFoldersAllowed([a], true)

    const { computer, held, until } = connected()
    await computer.start()
    await holding(held, [a])

    await setFoldersAllowed([b], true)
    await until((event) => event.type === "folders" && event.folders.length === 2)
    await holding(held, [a, b])

    await setFoldersAllowed([a], false)
    await holding(held, [b])
    await computer.stop()
  })

  // Guard proof: leave `existing` out of applyAllowedFolders; a deleted folder reads as online and
  // every message sent to it fails.
  test("holds no session for an allowed folder that's gone", async () => {
    const a = await folder("a")
    await setFoldersAllowed([a, join(home, "deleted")], true)

    const { computer, held } = connected()
    await computer.start()
    await holding(held, [a])
    await computer.stop()
  })

  // Guard proof: read the folders only when the list changes, dropping `recheck` from start; a folder
  // deleted while connected reads as online, and every message sent to it fails.
  test("closes the session of a folder that goes away while connected", async () => {
    const a = await folder("a")
    await setFoldersAllowed([a], true)
    // The filesystem's report of that write can arrive late, and would read the folders again too:
    // this test would pass without the recheck. Timers are real until here; faked, this never ends.
    await Bun.sleep(300)

    jest.useFakeTimers()
    const { computer, until } = connected()
    await computer.start()
    await until((event) => event.type === "folders" && event.folders.length === 1)

    await rm(a, { recursive: true })
    jest.advanceTimersByTime(20_000)
    await until((event) => event.type === "folders" && event.folders.length === 0)

    jest.useRealTimers()
    await computer.stop()
  })

  // Guard proof: report every failed renewal as lost, without the 401 check; a session that can
  // never come back retries for as long as nobody notices.
  test("says when its sign-in ended, rather than retrying", async () => {
    const a = await folder("a")
    await setFoldersAllowed([a], true)

    const { computer, until } = connected(() => 401)
    await computer.start()
    await until((event) => event.type === "signed-out")
    await computer.stop()
  })

  // Guard proof: call onSessionChange only when failing starts, in noteSession; a sign-in that ends
  // during an outage is never told apart from it, and this keeps retrying for good.
  test("says its sign-in ended when that follows a network failure", async () => {
    const a = await folder("a")
    await setFoldersAllowed([a], true)
    let status = 503

    jest.useFakeTimers()
    const { computer, until } = connected(() => status)
    await computer.start()
    await until((event) => event.type === "session.lost")

    status = 401
    jest.advanceTimersByTime(20_000)
    await until((event) => event.type === "signed-out")
    jest.useRealTimers()
    await computer.stop()
  })

  // Guard proof: report in noteSession whatever the last reason was; every failed renewal reports
  // again, every twenty seconds, for as long as the network is out.
  test("says once that a session was lost", async () => {
    const a = await folder("a")
    await setFoldersAllowed([a], true)
    let status = 503

    const { computer, events, until } = connected(() => status)
    await computer.start()
    await until((event) => event.type === "session.lost")
    expect(events.filter((event) => event.type === "session.lost")).toHaveLength(1)

    status = 200
    await computer.stop()
    expect(await thisComputerId()).toStartWith("cmp_")
  })
})
