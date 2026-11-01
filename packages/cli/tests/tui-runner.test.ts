import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSixbClient } from "@sixb/client"
import { thisComputerId } from "../src/tui/computer"
import type { Connection } from "../src/tui/connection"
import { LocalRunner, stopOnHangUp } from "../src/tui/runner"

// This computer as a runner: which turns `sixb` claims while it is open, how its session tells
// the project so, and how it lets go of the turns it runs when its terminal closes.

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

/**
 * Ava's sixb, open in FOLDER, against an API that answers her thread, its turn and her session:
 * the thread runs where `computer` says, by default on this computer in FOLDER.
 */
async function avasRunner(
  turn: { status: string },
  computer: { readonly id?: string; readonly folder?: string } = {},
  /** What a session's renewal waits for before it answers. */
  renewalGate: Promise<void> = Promise.resolve()
) {
  const thread = {
    id: "thr_1",
    projectId: "p",
    kind: "conversation",
    ownerPrincipal: { type: "user", id: "usr_ava" },
    participants: [],
    runsOn: "computer",
    computer: {
      id: computer.id ?? (await thisComputerId()),
      name: "Ava's MacBook Pro",
      folder: computer.folder ?? FOLDER,
      online: true,
    },
    status: "active",
    activeRunId: "run_1",
    messageCount: 1,
    createdAt: "2026-10-31T09:00:00.000Z",
    updatedAt: "2026-10-31T09:00:00.000Z",
  }
  const sessions: { readonly method: string; readonly body: unknown }[] = []
  const answer = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const path = new URL(request.url).pathname
    if (path === "/api/agent-threads/thr_1") return Response.json(thread)
    if (path === "/api/agent-runs/run_1") return Response.json({ id: "run_1", ...turn })
    if (path.startsWith("/api/agent-computers/sessions/")) {
      sessions.push({
        method: request.method,
        body: request.method === "PUT" ? await request.json() : undefined,
      })
      if (request.method === "DELETE") return new Response(null, { status: 204 })
      await renewalGate
      return Response.json({ expiresAt: "2026-10-31T09:01:00.000Z", waiting: ["run_9"] })
    }
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
  let heard = () => {}
  const claimedOne = new Promise<void>((resolve) => {
    heard = resolve
  })
  runner.claim = async (runId) => {
    claimed.push(runId)
    heard()
    return true
  }
  return { runner, claimed, claimedOne, sessions }
}

describe("sixb open in a conversation's folder", () => {
  // Guard proof: drop the `queued` check from LocalRunner.claimIfHere; the running turn is claimed
  // again, and its commands would run a second time.
  test("claims its queued turn, and leaves a running one to end where it runs", async () => {
    const turn = { status: "running" }
    const { runner, claimed } = await avasRunner(turn)
    runner.openSession()
    try {
      await runner.claimIfHere("thr_1")
      expect(claimed).not.toContain("run_1")

      turn.status = "queued"
      await runner.claimIfHere("thr_1")
      expect(claimed).toContain("run_1")
    } finally {
      await runner.closeSession()
    }
  })

  // Guard proof: drop the session check from LocalRunner.claimIfHere; with messages from the web
  // turned off, this sixb still runs the turn sent from there.
  test("leaves a turn sent from elsewhere alone while its session is closed", async () => {
    const { runner, claimed } = await avasRunner({ status: "queued" })
    await runner.claimIfHere("thr_1")
    expect(claimed).toEqual([])
  })
})

describe("a conversation that runs somewhere else", () => {
  // Guard proof: drop the folder or the computer check from LocalRunner.runsHere; this sixb claims
  // a turn of a conversation that works in another folder, or on Ava's desktop.
  test("is left to the folder and computer it runs in", async () => {
    for (const elsewhere of [{ folder: "/work/other" }, { id: "cmp_desktop" }]) {
      const { runner, claimed } = await avasRunner({ status: "queued" }, elsewhere)
      runner.openSession()
      try {
        await runner.claimIfHere("thr_1")
        expect(claimed).not.toContain("run_1")
      } finally {
        await runner.closeSession()
      }
    }
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

describe("a session", () => {
  // Guard proof: drop the loop over `waiting` from LocalRunner.openSession; the turn that queued
  // while sixb was closed waits until someone opens its conversation.
  test("names this folder, claims the turns waiting for it, and ends when sixb closes", async () => {
    const { runner, claimed, claimedOne, sessions } = await avasRunner({ status: "queued" })
    runner.openSession()
    await claimedOne
    expect(claimed).toEqual(["run_9"])
    expect(sessions[0]).toEqual({
      method: "PUT",
      body: {
        computer: { id: await thisComputerId(), name: expect.any(String), folder: FOLDER },
      },
    })

    await runner.closeSession()
    expect(sessions.at(-1)?.method).toBe("DELETE")
  })
})

describe("a session closing while its renewal is on its way", () => {
  // Guard proof: drop the session check after the PUT in openSession; the turn runs here after the
  // person turned Messages from the web off, or quit. Drop `this.renewal` from closeSession's
  // release; the DELETE overtakes the PUT, which opens the session again.
  test("claims nothing the renewal lists, and releases the session after it", async () => {
    let answer = () => {}
    const gate = new Promise<void>((resolve) => {
      answer = resolve
    })
    const { runner, claimed, sessions } = await avasRunner({ status: "queued" }, {}, gate)
    runner.openSession()
    while (sessions.length === 0) await Bun.sleep(0)

    const closed = runner.closeSession()
    for (let turn = 0; turn < 5; turn += 1) await Bun.sleep(0)
    expect(sessions.map((session) => session.method)).toEqual(["PUT"])

    answer()
    await closed
    expect(sessions.map((session) => session.method)).toEqual(["PUT", "DELETE"])
    expect(claimed).toEqual([])
  })

  // Guard proof: drop `&& this.session` from claimIfHere; a turn it was reading about when the
  // session closed runs here anyway.
  test("claims no turn it was still reading about", async () => {
    const { runner, claimed } = await avasRunner({ status: "queued" })
    runner.openSession()
    await runner.closeSession()
    claimed.length = 0
    runner.openSession()

    const reading = runner.claimIfHere("thr_1", "run_1")
    const closing = runner.closeSession()
    await Promise.all([reading, closing])
    expect(claimed).toEqual([])
  })
})

describe("a turn claimed here already", () => {
  // Guard proof: drop the running check from claimElsewhere; a message typed here is announced as
  // sent from elsewhere, when its own activity event arrives while its claim is on its way.
  test("is not taken for one sent from elsewhere", async () => {
    const { runner, claimed } = await avasRunner({ status: "queued" })
    const inner = runner as unknown as {
      running: Map<string, { stop: AbortController; done: Promise<boolean> }>
      sentElsewhere: Set<string>
    }
    runner.openSession()
    inner.running.set("run_1", { stop: new AbortController(), done: Promise.resolve(true) })

    await runner.claimIfHere("thr_1", "run_1")

    expect(claimed).toContain("run_1")
    expect(inner.sentElsewhere.has("run_1")).toBe(false)
    inner.running.clear()
    await runner.closeSession()
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
