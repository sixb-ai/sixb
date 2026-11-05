import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSixbClient } from "@sixb/client"
import type { Connection } from "../src/lib/connection"
import { setFoldersAllowed } from "../src/runner/allowed-folders"
import { ComputerConnection, type ComputerEvent } from "../src/runner/computer-connection"
import { LocalRunner } from "../src/runner/local-runner"

// A computer connected to a project, against an API that answers sessions: which folders it holds
// a session for, and how those follow the list of allowed folders.

const API = "http://api.localhost"
const THIS_PROJECT = { apiUrl: API, project: { id: "p", timeZone: "UTC", locale: "en" } }

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

function connected(respond: (status: number) => number = () => 200, baseUrl = API) {
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
    baseUrl,
    fetch: Object.assign(answer, { preconnect: fetch.preconnect }),
  })
  const connection: Connection = {
    ...THIS_PROJECT,
    client,
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
  // Guard proof: drop `cancelRequested` from onActivity in start; a stop asked for in the app leaves the
  // agent's commands running until the turn's next lease renewal, up to ten seconds away.
  test("hears a stop asked for elsewhere at once", async () => {
    const heard = spyOn(LocalRunner.prototype, "hearStop").mockImplementation(() => {})
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request, serving) =>
        serving.upgrade(request) ? undefined : new Response(null, { status: 426 }),
      websocket: {
        message(socket) {
          const event = {
            schemaVersion: 1,
            type: "agent.run.activity",
            projectId: "p",
            threadId: "thr_1",
            status: "running",
            attempt: 1,
            runsOn: "computer",
            occurredAt: "2026-11-04T09:00:00.000Z",
          }
          // One that isn't a stop first: what it hears from the second alone proves the first passed by.
          socket.send(JSON.stringify({ type: "activity", event: { ...event, runId: "run_1" } }))
          socket.send(
            JSON.stringify({
              type: "activity",
              event: { ...event, runId: "run_2", cancelRequested: true },
            })
          )
        },
      },
    })
    try {
      const a = await folder("a")
      await setFoldersAllowed(THIS_PROJECT, [a], true)
      const { computer, until } = connected(undefined, `http://127.0.0.1:${server.port}`)
      await computer.start()
      await until((event) => event.type === "folders")
      for (let turn = 0; turn < 400 && heard.mock.calls.length === 0; turn += 1) await Bun.sleep(5)

      expect(heard.mock.calls).toEqual([["run_2"]])
      await computer.stop()
    } finally {
      heard.mockRestore()
      server.stop(true)
    }
  })

  // Guard proof: open a session for every folder a conversation names, or leave reconcile out of
  // start; the computer reads as online where nobody chose, or nowhere.
  test("holds a session for each allowed folder, and for no other", async () => {
    const [a, b] = await Promise.all([folder("a"), folder("b")])
    await folder("not-allowed")
    await setFoldersAllowed(THIS_PROJECT, [a, b], true)

    const { computer, held, until } = connected()
    await computer.start()
    await until((event) => event.type === "folders")
    await holding(held, [a, b])

    await computer.stop()
    await holding(held, [])
  })

  // Guard proof: read the list without the connection's project, in readAllowed; a sign-in stolen for
  // one project runs turns in the folders chosen for another.
  test("holds none for a folder allowed for another project", async () => {
    const [a, b] = await Promise.all([folder("a"), folder("b")])
    await setFoldersAllowed({ ...THIS_PROJECT, apiUrl: "https://another.test" }, [a], true)
    await setFoldersAllowed(THIS_PROJECT, [b], true)

    const { computer, held, until } = connected()
    await computer.start()
    await until((event) => event.type === "folders")
    await holding(held, [b])
    await computer.stop()
  })

  // Guard proof: drop watchAllowedFolders from start; choosing a folder needs a restart, and
  // forgetting one leaves it running messages from the web until then.
  test("follows the list with no restart", async () => {
    const [a, b] = await Promise.all([folder("a"), folder("b")])
    await setFoldersAllowed(THIS_PROJECT, [a], true)

    const { computer, held, until } = connected()
    await computer.start()
    await holding(held, [a])

    await setFoldersAllowed(THIS_PROJECT, [b], true)
    await until((event) => event.type === "folders" && event.folders.length === 2)
    await holding(held, [a, b])

    await setFoldersAllowed(THIS_PROJECT, [a], false)
    await holding(held, [b])
    await computer.stop()
  })

  // Guard proof: drop `signedOut` from onSessionChange; whatever stops on this runs once per folder, and
  // says so as many times.
  test("says once that the sign-in ended, however many folders knew", async () => {
    const [a, b] = await Promise.all([folder("a"), folder("b")])
    await setFoldersAllowed(THIS_PROJECT, [a, b], true)
    let answered = 0
    const { computer, events, until } = connected(() => {
      answered += 1
      return 401
    })
    await computer.start()
    await until((event) => event.type === "signed-out")
    for (let turn = 0; turn < 200 && answered < 2; turn += 1) await Bun.sleep(5)
    // The second answer's own turn of the loop.
    await Bun.sleep(20)

    expect(answered).toBe(2)
    expect(events.filter((event) => event.type === "signed-out")).toHaveLength(1)
    await computer.stop()
  })

  // Guard proof: only close the session in applyAllowedFolders; a folder taken back goes on having
  // commands run in it, unasked, until the turn ends.
  test("stops what runs in a folder taken back", async () => {
    const stopped = spyOn(LocalRunner.prototype, "stop")
    try {
      const [a, b] = await Promise.all([folder("a"), folder("b")])
      await setFoldersAllowed(THIS_PROJECT, [a, b], true)
      const { computer, held, until } = connected()
      await computer.start()
      await until((event) => event.type === "folders")
      await holding(held, [a, b])

      await setFoldersAllowed(THIS_PROJECT, [a], false)
      await holding(held, [b])
      expect(
        stopped.mock.contexts.map((runner) => (runner as unknown as LocalRunner).folder)
      ).toEqual([a])
      await computer.stop()
    } finally {
      stopped.mockRestore()
    }
  })

  // Guard proof: leave `existing` out of applyAllowedFolders; a deleted folder reads as online and
  // every message sent to it fails.
  test("holds no session for an allowed folder that's gone", async () => {
    const a = await folder("a")
    await setFoldersAllowed(THIS_PROJECT, [a, join(home, "deleted")], true)

    const { computer, held } = connected()
    await computer.start()
    await holding(held, [a])
    await computer.stop()
  })

  // Guard proof: read the folders only when the list changes, dropping `recheck` from start; a folder
  // deleted while connected reads as online, and every message sent to it fails.
  test("closes the session of a folder that goes away while connected", async () => {
    const stopped = spyOn(LocalRunner.prototype, "stop")
    const a = await folder("a")
    await setFoldersAllowed(THIS_PROJECT, [a], true)
    // macOS can report that write late: a report after the folder goes would read the folders again,
    // and this test would pass with the recheck gone. Real time because there's no event to wait for,
    // and before the fake timers, which would stop it.
    await Bun.sleep(300)

    jest.useFakeTimers()
    const { computer, until } = connected()
    await computer.start()
    await until((event) => event.type === "folders" && event.folders.length === 1)

    await rm(a, { recursive: true })
    jest.advanceTimersByTime(20_000)
    await until((event) => event.type === "folders" && event.folders.length === 0)

    // A volume that went away may come back: what runs there isn't stopped for that.
    expect(stopped).not.toHaveBeenCalled()
    stopped.mockRestore()
    jest.useRealTimers()
    await computer.stop()
  })

  // Guard proof: report every failed renewal as lost, without the 401 check; a session that can
  // never come back retries for as long as nobody notices.
  test("says when its sign-in ended, rather than retrying", async () => {
    const a = await folder("a")
    await setFoldersAllowed(THIS_PROJECT, [a], true)

    const { computer, until } = connected(() => 401)
    await computer.start()
    await until((event) => event.type === "signed-out")
    await computer.stop()
  })

  // Guard proof: call onSessionChange only when failing starts, in noteSession; a sign-in that ends
  // during an outage is never told apart from it, and this keeps retrying for good.
  test("says its sign-in ended when that follows a network failure", async () => {
    const a = await folder("a")
    await setFoldersAllowed(THIS_PROJECT, [a], true)
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
    await setFoldersAllowed(THIS_PROJECT, [a], true)
    let renewals = 0
    let reachedSecond = () => {}
    const second = new Promise<void>((resolve) => {
      reachedSecond = resolve
    })

    jest.useFakeTimers()
    // The third is refused differently, and says so: what the second said has landed by then.
    const { computer, events, until } = connected(() => {
      renewals += 1
      if (renewals === 2) reachedSecond()
      return renewals === 3 ? 401 : 503
    })
    await computer.start()
    await until((event) => event.type === "session.lost")

    jest.advanceTimersByTime(20_000)
    await second
    // Timers are faked, and a message still yields: the second's answer lands before the third asks.
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise<void>((resolve) => {
        const channel = new MessageChannel()
        channel.port1.onmessage = () => {
          channel.port1.close()
          resolve()
        }
        channel.port2.postMessage(null)
      })
    }
    jest.advanceTimersByTime(20_000)
    await until((event) => event.type === "signed-out")
    expect(events.filter((event) => event.type === "session.lost")).toHaveLength(1)

    jest.useRealTimers()
    await computer.stop()
  })
})
