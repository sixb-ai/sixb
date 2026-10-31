import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSixbClient } from "@sixb/client"
import { thisComputerId } from "../src/tui/computer"
import type { Connection } from "../src/tui/connection"
import { rememberFolder } from "../src/tui/folders"
import { LocalRunner, stopOnHangUp } from "../src/tui/runner"

// This computer as a runner: which turns `sixb` claims when it opens, and how it lets go of the
// ones it runs when its terminal closes.

const API = "http://api.localhost"
const FOLDER = "/work/q3-close"

let configHome: string
let previousConfigHome: string | undefined

beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), "sixb-tui-runner-"))
  await mkdir(join(configHome, "sixb"), { recursive: true })
  previousConfigHome = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = configHome
})

afterEach(async () => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previousConfigHome
  await rm(configHome, { recursive: true, force: true })
})

/** Ava's sixb, open in FOLDER, against an API that answers her thread and its turn. */
function avasRunner(turn: { status: string }, on: { computerId?: string } = {}) {
  const thread = {
    ...on,
    id: "thr_1",
    projectId: "p",
    kind: "conversation",
    ownerPrincipal: { type: "user", id: "usr_ava" },
    participants: [],
    runsOn: "computer",
    status: "active",
    activeRunId: "run_1",
    messageCount: 1,
    createdAt: "2026-10-31T09:00:00.000Z",
    updatedAt: "2026-10-31T09:00:00.000Z",
  }
  const answer = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(new Request(input, init).url).pathname
    if (path === "/api/agent-threads/thr_1") return Response.json(thread)
    if (path === "/api/agent-runs/run_1") return Response.json({ id: "run_1", ...turn })
    return Response.json({ error: "Not found" }, { status: 404 })
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

  const runner = new LocalRunner(connection, FOLDER, () => {})
  const claimed: string[] = []
  runner.claim = async (runId) => {
    claimed.push(runId)
    return true
  }
  return { runner, claimed }
}

describe("sixb opening in a conversation's folder", () => {
  // Guard proof: drop the `queued` check from LocalRunner.claimIfHere; the running turn is claimed
  // again, and its commands would run a second time.
  test("claims its queued turn, and leaves a running one to end where it runs", async () => {
    await rememberFolder("thr_1", FOLDER)
    const turn = { status: "running" }
    const { runner, claimed } = avasRunner(turn)

    await runner.claimIfHere("thr_1")
    expect(claimed).toEqual([])

    turn.status = "queued"
    await runner.claimIfHere("thr_1")
    expect(claimed).toEqual(["run_1"])
  })
})

describe("a conversation on another of Ava's computers", () => {
  // Guard proof: drop the runsOnThisComputer check from LocalRunner.claimIfHere; this computer
  // claims a turn of the conversation she moved to her desktop, in the folder it left.
  test("is left to that computer, though it worked in this folder before", async () => {
    await rememberFolder("thr_1", FOLDER)
    const elsewhere = avasRunner({ status: "queued" }, { computerId: "cmp_desktop" })
    await elsewhere.runner.claimIfHere("thr_1")
    expect(elsewhere.claimed).toEqual([])

    const here = avasRunner({ status: "queued" }, { computerId: await thisComputerId() })
    await here.runner.claimIfHere("thr_1")
    expect(here.claimed).toEqual(["run_1"])
  })

  // Guard proof: name the computer anew on each run of sixb, without the file; the id read back
  // is not the one kept, and every claim would name a computer the thread never ran on.
  test("is told apart by an id this computer keeps, readable by its user alone", async () => {
    const id = await thisComputerId()
    const file = join(configHome, "sixb", "computer.json")

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ id })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })
})

describe("a closed terminal", () => {
  // Guard proof: drop the SIGHUP handler from stopOnHangUp; nothing stops the turn, which keeps
  // renewing its lease from a process nobody sees.
  test("stops the turns running here, then exits", async () => {
    const steps: string[] = []
    let exited = () => {}
    const exit = new Promise<void>((resolve) => {
      exited = resolve
    })
    const unhook = stopOnHangUp(
      () => ({
        busy: true,
        stop: async () => {
          steps.push("stop")
        },
      }),
      (signal) => {
        steps.push(`exit ${signal}`)
        exited()
      }
    )

    try {
      process.emit("SIGHUP")
      expect(steps).toEqual(["stop"])
      await exit
      expect(steps).toEqual(["stop", "exit SIGHUP"])
    } finally {
      unhook()
    }
  })
})
