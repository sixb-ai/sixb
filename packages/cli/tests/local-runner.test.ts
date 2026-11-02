import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  ComputerBackgroundCommand,
  ComputerBackgroundCommandRef,
  ComputerRunner,
} from "@sixb/agent"
import { createSixbClient } from "@sixb/client"
import type { Connection } from "../src/lib/connection"
import { thisComputerId } from "../src/runner/computer"
import { createKeepAwake } from "../src/runner/keep-awake"
import { LocalRunner, stopOnHangUp, stopOnQuit } from "../src/runner/local-runner"

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
  /** What a renewal's answer adds: the commands the web asked to stop. */
  const renewals: { stop?: readonly object[] } = {}
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
      return Response.json({
        expiresAt: "2026-10-31T09:01:00.000Z",
        waiting: ["run_9"],
        ...renewals,
      })
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
  return { runner, claimed, claimedOne, sessions, renewals }
}

/** The background commands of Ava's runner, as its ComputerRunner would report and stop them. */
function backgroundOf(runner: LocalRunner, commands: readonly ComputerBackgroundCommand[]) {
  const stopped: ComputerBackgroundCommandRef[] = []
  const fake: Pick<ComputerRunner, "backgroundCommands" | "stopBackgroundCommand"> = {
    backgroundCommands: () => commands,
    stopBackgroundCommand: async (ref) => {
      stopped.push(ref)
      return true
    },
  }
  Object.assign(runner, { runner: fake })
  return { stopped }
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

describe("a background command", () => {
  const ref = { threadId: "thr_1", id: "bg_1", startedAt: "2026-10-31T09:00:00.000Z" }
  const running = { ...ref, command: "bun run dev", status: "running" as const }

  // Guard proofs: drop the loop over `stop` from openSession; the command Ava stopped from the web
  // runs on. Drop backgroundCommands from the session's body; the web never shows it.
  test("is reported with the session, and stopped when the web asks", async () => {
    const { runner, sessions, renewals } = await avasRunner({ status: "running" })
    const { stopped } = backgroundOf(runner, [running])
    renewals.stop = [ref]

    runner.openSession()
    try {
      while (sessions.length === 0) await Bun.sleep(0)
      for (let turn = 0; turn < 5; turn += 1) await Bun.sleep(0)
      expect(sessions[0]?.body).toMatchObject({ backgroundCommands: [running] })
      expect(stopped).toEqual([ref])
    } finally {
      await runner.closeSession()
    }
  })

  // Guard proof: drop `queued` from openSession's renew; each change sends its own renewal, and
  // they may land out of order, an older report over a newer one.
  test("renews the session at once as it changes, one renewal at a time", async () => {
    let answer = () => {}
    const gate = new Promise<void>((resolve) => {
      answer = resolve
    })
    const { runner, sessions } = await avasRunner({ status: "running" }, {}, gate)
    backgroundOf(runner, [running])

    runner.openSession()
    try {
      while (sessions.length === 0) await Bun.sleep(0)
      runner.renewSession()
      runner.renewSession()
      runner.renewSession()
      for (let turn = 0; turn < 5; turn += 1) await Bun.sleep(0)
      expect(sessions).toHaveLength(1)

      answer()
      while (sessions.length < 2) await Bun.sleep(0)
      for (let turn = 0; turn < 5; turn += 1) await Bun.sleep(0)
      expect(sessions).toHaveLength(2)
    } finally {
      await runner.closeSession()
    }
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

describe("a turn sent from elsewhere", () => {
  /** A runner whose claims go through for real, up to the turn they run. */
  async function claimingRunner() {
    const { runner, sessions } = await avasRunner({ status: "queued" })
    runner.claim = LocalRunner.prototype.claim
    const heard: string[] = []
    runner.onElsewhere((run) => heard.push(run.id))
    const started: string[] = []
    const turns = new Map<string, () => void>()
    const inner = runner as unknown as {
      runner: {
        runTurn(
          id: string,
          signal: AbortSignal,
          onClaimed?: (run: { id: string }) => void
        ): Promise<boolean>
      }
    }
    inner.runner.runTurn = (id, _signal, onClaimed) => {
      started.push(id)
      return new Promise((resolve) => {
        turns.set(id, () => {
          onClaimed?.({ id })
          resolve(true)
        })
      })
    }
    const claimedBy = (id: string) => turns.get(id)?.()
    return { runner, heard, started, claimedBy, sessions }
  }

  // Guard proof: announce from claim instead of from claimElsewhere's callback; each message typed
  // here reads as sent from elsewhere.
  test("is announced as it is claimed", async () => {
    const { runner, heard, started, claimedBy, sessions } = await claimingRunner()
    runner.openSession()
    while (started.length === 0) await Bun.sleep(0)
    expect(started).toEqual(["run_9"])

    claimedBy("run_9")
    expect(heard).toEqual(["run_9"])
    expect(sessions[0]?.method).toBe("PUT")
    await runner.closeSession()
  })

  // Guard proof: let a joining claim replace the first one's callback; the message typed here, heard
  // of again on its way through the session, reads as sent from elsewhere.
  test("is not what a message typed here becomes, heard of on its way", async () => {
    const { runner, heard, started, claimedBy, sessions } = await claimingRunner()
    const typed = runner.claim("run_9")
    runner.openSession()
    while (sessions.length === 0) await Bun.sleep(0)
    await runner.closeSession()

    expect(started).toEqual(["run_9"])
    claimedBy("run_9")
    await typed
    expect(heard).toEqual([])
  })
})

describe("staying awake", () => {
  // Guard proof: end the process's hold after each turn instead of counting them, in createKeepAwake;
  // the computer sleeps through a turn that's still running because another one finished.
  test("holds while any turn runs, and starts and stops once", () => {
    let starts = 0
    let stops = 0
    const { hold } = createKeepAwake(() => {
      starts += 1
      return () => {
        stops += 1
      }
    })

    const first = hold()
    const second = hold()
    first()
    first()
    expect([starts, stops]).toEqual([1, 0])
    second()
    expect([starts, stops]).toEqual([1, 1])

    hold()()
    expect([starts, stops]).toEqual([2, 2])
  })

  // Guard proof: release before runTurn has ended, or never, in LocalRunner.claim; the computer sleeps
  // in the middle of a turn, or stays awake for good.
  test.each([
    [true, 1],
    [false, 0],
  ])("a turn holds it for as long as it runs, when the setting is %s", async (setting, holds) => {
    const { runner } = await avasRunner({ status: "queued" })
    runner.claim = LocalRunner.prototype.claim
    let held = 0
    let released = 0
    const awake = new LocalRunner(
      (runner as unknown as { connection: Connection }).connection,
      FOLDER,
      () => {},
      {
        holdAwake: () => {
          held += 1
          return () => {
            released += 1
          }
        },
      }
    )
    awake.keepsAwake = setting
    let finish = (_ran: boolean) => {}
    const inner = awake as unknown as { runner: { runTurn(): Promise<boolean> } }
    inner.runner.runTurn = () =>
      new Promise((resolve) => {
        finish = resolve
      })

    const turn = awake.claim("run_1")
    expect([held, released]).toEqual([holds, 0])
    finish(true)
    await turn
    expect([held, released]).toEqual([holds, holds])
  })
})

describe("turns sent from elsewhere", () => {
  // Guard proof: drop the running check from claimElsewhere; two turns edit the same files at once,
  // with nobody watching. Drop the renewal after a turn from claim; the next one waits up to twenty
  // seconds for no reason. Renew after a turn that didn't run as well; this test never ends, and a
  // refused claim hammers the project.
  test("run one at a time, the next as soon as the first ends", async () => {
    const { runner, sessions } = await avasRunner({ status: "queued" })
    runner.claim = LocalRunner.prototype.claim
    const started: string[] = []
    let finishFirst = () => {}
    const inner = runner as unknown as {
      runner: { runTurn(id: string): Promise<boolean> }
    }
    inner.runner.runTurn = (id) => {
      started.push(id)
      // Listed again, and refused: renewing after this one would ask forever.
      if (started.length > 1) return Promise.resolve(false)
      return new Promise((resolve) => {
        finishFirst = () => resolve(true)
      })
    }

    runner.openSession()
    while (started.length === 0) await Bun.sleep(0)
    await runner.claimIfHere("thr_1", "run_1")
    expect(started).toEqual(["run_9"])

    const renewals = sessions.filter((session) => session.method === "PUT").length
    finishFirst()
    while (sessions.filter((session) => session.method === "PUT").length === renewals) {
      await Bun.sleep(0)
    }
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

describe("quitting sixb", () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  // Guard proof: stop only a busy runner in stopOnQuit, as quitting once did; the background
  // commands then run on after sixb exits.
  test("stops the background commands its turns left, though no turn runs", async () => {
    const steps: string[] = []
    await stopOnQuit(
      {
        busy: false,
        runsBackgroundCommands: true,
        stop: async () => {
          steps.push("stop")
        },
      },
      10_000,
      (text) => steps.push(text)
    )

    expect(steps).toEqual(["Stopping the background commands running here…", "stop"])
  })

  test("waits for them no longer than its bound", async () => {
    jest.useFakeTimers()
    const quitting = stopOnQuit(
      { busy: true, runsBackgroundCommands: true, stop: () => new Promise(() => {}) },
      10_000,
      () => {}
    )
    jest.advanceTimersByTime(10_000)

    await quitting
  })
})
