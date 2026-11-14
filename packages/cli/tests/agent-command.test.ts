import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { ServerWebSocket } from "bun"
import { FAST_CLI_TIMEOUT_MS, runCliToCompletion } from "./shared/cli-process"

// `sixb agent` against a fake API: what a script reads of a turn is its exit code and stdout.

const CLI = resolve(import.meta.dir, "..", "src", "index.tsx")
const REPOSITORY = resolve(import.meta.dir, "..", "..", "..")
const THREAD = "agt_thread_1"
const RUN = "agt_run_1"

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** How the fake API answers: the thread, the turn's stream, and the turn as it ended. */
interface Script {
  readonly thread?: Response | (() => Response)
  /** The person's mode in the thread, as reading it says. */
  readonly mode?: string
  readonly stream?: (socket: ServerWebSocket<unknown>) => void
  readonly run?: Record<string, unknown>
  /** The turn stays queued, as nothing has taken it. */
  readonly queued?: boolean
  /** Answers a read of the turn in place of `queued`, when it returns a response. */
  readonly runRead?: () => Response | null
  /** The thread's messages, newest first, as a read of them lists them. */
  readonly messages?: readonly Record<string, unknown>[]
}

async function fakeApi(script: Script) {
  const posted: Record<string, unknown>[] = []
  const claims: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, server) {
      const path = new URL(request.url).pathname
      if (path === "/ws/agents") {
        return server.upgrade(request) ? undefined : new Response("no upgrade", { status: 400 })
      }

      if (path === "/api/project")
        return Response.json({ id: "acme", timeZone: "UTC", locale: "en" })
      if (path === "/api/auth/session") {
        return Response.json({ authenticated: false, authEnabled: false })
      }
      if (path === "/api/models") return Response.json({ language: [] })

      if (path === `/api/agent-threads/${THREAD}`) {
        return (
          (typeof script.thread === "function" ? script.thread() : script.thread?.clone()) ??
          Response.json({
            id: THREAD,
            runsOn: "cloud",
            ...(script.mode ? { approvalMode: script.mode } : {}),
          })
        )
      }
      if (path === `/api/agent-threads/${THREAD}/messages` && request.method === "POST") {
        posted.push(await request.json())
        return Response.json({ run: { id: RUN } })
      }
      if (path === `/api/agent-threads/${THREAD}/messages`) {
        return Response.json({ messages: script.messages ?? [] })
      }
      if (path === `/api/agent-runs/${RUN}/claim`) {
        claims.push(RUN)
        return Response.json({ error: { kind: "Error", message: "No." } }, { status: 409 })
      }
      if (path === `/api/agent-runs/${RUN}`) {
        const scripted = script.runRead?.()
        if (scripted) return scripted
        return Response.json({ id: RUN, status: script.queued ? "queued" : "succeeded" })
      }
      if (path === `/api/agent-threads/${THREAD}/runs`) {
        return Response.json({ runs: [{ id: RUN, ...script.run }] })
      }

      return new Response("not found", { status: 404 })
    },
    websocket: {
      message(socket, message) {
        if (JSON.parse(String(message)).type === "subscribe") script.stream?.(socket)
      },
    },
  })
  cleanups.push(() => server.stop(true))

  const config = await mkdtemp(join(tmpdir(), "sixb-agent-command-"))
  cleanups.push(() => rm(config, { recursive: true, force: true }))

  return {
    config,
    posted,
    claims,
    env: {
      XDG_CONFIG_HOME: config,
      SIXB_API_URL: `http://127.0.0.1:${server.port}`,
      SIXB_API_TOKEN: "sixb_pat_test.secret",
      SIXB_API_PUBLIC_ORIGIN: undefined,
      SIXB_TOKEN: undefined,
      SIXB_PROFILE: undefined,
    },
  }
}

function snapshot(status: string) {
  return JSON.stringify({
    type: "run.snapshot",
    run: {
      id: RUN,
      projectId: "acme",
      threadId: THREAD,
      triggerMessageId: "agt_msg_1",
      status,
      attempt: 1,
      streamId: "s1",
      createdAt: "2026-10-31T00:00:00.000Z",
    },
  })
}

/** A thread that runs on a computer: `id` names this one when it has kept `computer.json`. */
function computerThread(computer: { id: string; folder: string; online: boolean }) {
  return Response.json({
    id: THREAD,
    runsOn: "computer",
    computer: { name: "Ava's iMac", ...computer },
  })
}

function runAgent(env: Record<string, string | undefined>, ...args: string[]) {
  return runCliToCompletion({
    cmd: ["bun", CLI, "agent", "--cloud", "--thread", THREAD, ...args, "Count the open cases."],
    cwd: resolve(import.meta.dir, "..", "..", ".."),
    env,
    timeoutMs: FAST_CLI_TIMEOUT_MS,
  })
}

/** A message to the conversation, with no opinion on where it runs. */
function sendTo(env: Record<string, string | undefined>, ...args: string[]) {
  return runCliToCompletion({
    cmd: ["bun", CLI, "agent", "--thread", THREAD, ...args, "Tidy the notes"],
    cwd: resolve(import.meta.dir, "..", "..", ".."),
    env,
    timeoutMs: FAST_CLI_TIMEOUT_MS,
  })
}

describe("sixb agent", () => {
  // Guard proof: in printAnswer (src/commands/agent.ts), move `process.exitCode = 1` back after
  // the `if (json) { … return }` branch, or test only `failed`: both cases exit 0.
  test.each([
    "failed",
    "cancelled",
  ])("exits 1 when its turn ended %s, with --json too", async (status) => {
    const { env } = await fakeApi({
      stream: (socket) => socket.send(snapshot(status)),
      run: { status, finishReason: null, error: { message: "The model failed." } },
    })

    for (const json of [true, false]) {
      const result = await runAgent(env, ...(json ? ["--json"] : []))

      expect(result.exitCode).toBe(1)
      if (json) expect(JSON.parse(result.stdout)).toMatchObject({ runId: RUN, status })
    }
  })

  // Guard proof: in runAgent (src/commands/agent.ts), drop the exit code set when `follow` comes
  // back `failed` or `stopped`: both cases exit 0 on a turn that is still running.
  test("exits 1 when it stops following a turn that still runs", async () => {
    let child: ReturnType<typeof Bun.spawn> | undefined
    const lost = await fakeApi({
      stream: (socket) => socket.send(JSON.stringify({ type: "error", message: "Stream lost." })),
      run: { status: "running", finishReason: null },
    })
    const interrupted = await fakeApi({
      // Subscribed means the turn is being followed: Ctrl+C now stops the waiting, not the CLI.
      stream: () => child?.kill("SIGINT"),
      run: { status: "running", finishReason: null },
    })

    const result = await runAgent(lost.env, "--json")
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "running" })

    child = Bun.spawn({
      cmd: ["bun", CLI, "agent", "--cloud", "--json", "--thread", THREAD, "Count the open cases."],
      cwd: resolve(import.meta.dir, "..", "..", ".."),
      env: { ...process.env, ...interrupted.env },
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child?.kill("SIGKILL"), FAST_CLI_TIMEOUT_MS)
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout as ReadableStream).text(),
    ])
    clearTimeout(timer)

    expect(child.signalCode).toBeNull()
    expect(exitCode).toBe(1)
    expect(JSON.parse(stdout)).toMatchObject({ status: "running" })
  })

  // Guard proofs: in printAnswer (src/commands/agent.ts), drop the questions; a turn that ended on
  // one prints nothing, and --json gives empty text. Send `text` as typed in runAgent; "2" reaches
  // the model alone.
  test("prints the questions a turn ended on, and a choice's number answers with that choice", async () => {
    const asked = {
      id: "agt_msg_2",
      threadId: THREAD,
      runId: RUN,
      role: "assistant",
      createdAt: "2026-10-31T00:00:01.000Z",
      parts: [
        {
          type: "tool-call",
          toolCallId: "ask_1",
          toolName: "ask",
          state: "output-available",
          input: {
            questions: [{ question: "Which environment?", choices: ["staging", "production"] }],
          },
          output: { status: "asked" },
        },
      ],
    }
    const { env, posted } = await fakeApi({
      messages: [asked],
      stream: (socket) => socket.send(snapshot("succeeded")),
      run: { status: "succeeded", finishReason: "stop" },
    })

    const shown = await runAgent(env)
    expect(shown.stdout).toContain("Which environment?\n  1. staging\n  2. production")
    expect(shown.stderr).toContain(`sixb agent --thread ${THREAD}`)
    const json = await runAgent(env, "--json")
    expect(JSON.parse(json.stdout).questions).toEqual([
      { question: "Which environment?", choices: ["staging", "production"], multiple: false },
    ])

    const answered = await runCliToCompletion({
      cmd: ["bun", CLI, "agent", "--cloud", "--json", "--thread", THREAD, "2"],
      cwd: resolve(import.meta.dir, "..", "..", ".."),
      env,
      timeoutMs: FAST_CLI_TIMEOUT_MS,
    })
    expect(answered.exitCode).toBe(0)
    expect(posted.at(-1)?.text).toBe("production")
  })

  // Guard proof: in runAgent (src/commands/agent.ts), send `approvalMode: settings.approvalMode`
  // again: the message carries the terminal's Full access, which the thread never chose.
  test("sends a mode only when --approval-mode names one; the thread's applies otherwise", async () => {
    const { env, config, posted } = await fakeApi({
      mode: "manual",
      stream: (socket) => socket.send(snapshot("succeeded")),
      run: { status: "succeeded", finishReason: null },
    })
    // The terminal app's own mode, for the conversations it starts.
    await mkdir(join(config, "sixb"), { recursive: true })
    await writeFile(join(config, "sixb", "tui.json"), JSON.stringify({ approvalMode: "auto" }))

    const followed = await runAgent(env)
    const chosen = await runAgent(env, "--approval-mode", "accept-edits")

    expect(followed.exitCode).toBe(0)
    expect(followed.stderr).toContain("Ask first")
    expect(chosen.stderr).toContain("Allow edits")
    expect(posted.map((body) => body.approvalMode)).toEqual([undefined, "accept-edits"])
  })

  // Guard proof: drop `agent` from wantsManagementJson (src/lib/command-line.ts), or the
  // `isSixbApiError` branch from cliExitCode (src/index.tsx): the error goes to stdout as a box,
  // or the command exits 1.
  test("exits 3 on an API error, which --json writes to stderr as JSON", async () => {
    const { env } = await fakeApi({
      thread: Response.json({ error: "Not your conversation." }, { status: 403 }),
    })

    const result = await runAgent(env, "--json")

    expect(result.exitCode).toBe(3)
    expect(result.stdout).toBe("")
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: "api_error", status: 403 },
    })
  })

  // Guard proof: drop the offline check from runAgent; the command follows a turn nothing will run,
  // until someone stops it.
  test("says a turn waits for a computer that isn't connected, and exits 5", async () => {
    const { env, posted } = await fakeApi({
      queued: true,
      thread: computerThread({ id: "cmp_other", folder: "/work/q3", online: false }),
    })
    const result = await sendTo(env, "--json")

    expect(result.exitCode).toBe(5)
    expect(JSON.parse(result.stdout)).toEqual({ threadId: THREAD, runId: RUN, status: "queued" })
    expect(result.stderr).toContain("It waits until /work/q3 is connected on Ava's iMac")
    expect(posted).toHaveLength(1)
  })

  // Guard proof: refuse a conversation from another folder before posting, as the command first did;
  // a connected computer can't be reached from anywhere but its own folder.
  test("follows a turn a connected computer runs elsewhere", async () => {
    const { env } = await fakeApi({
      thread: computerThread({ id: "cmp_other", folder: "/work/q3", online: true }),
      stream: (socket) => socket.send(snapshot("succeeded")),
      run: { status: "succeeded" },
    })
    const result = await sendTo(env)

    expect(result.exitCode).toBe(0)
  })

  // Guard proof: drop the detach branch from runAgent; a script that only wants to send waits for
  // the turn, or for a computer nobody opens.
  test("with --detach, sends and exits with the ids, whoever runs it", async () => {
    const { env, posted } = await fakeApi({
      thread: computerThread({ id: "cmp_other", folder: "/work/q3", online: false }),
    })
    const result = await sendTo(env, "--detach", "--json")

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ threadId: THREAD, runId: RUN, status: "queued" })
    expect(posted).toHaveLength(1)
  })

  // Guard proof: follow forever in runnerUntilHeld once the turn is someone else's; a session that
  // outlives its crashed sixb leaves a script waiting for good.
  test("exits 5 when what held the conversation's folder goes away", async () => {
    let reads = 0
    const { env } = await fakeApi({
      queued: true,
      thread: () => {
        reads += 1
        return computerThread({ id: "cmp_other", folder: "/work/q3", online: reads <= 2 })
      },
    })
    const result = await sendTo(env, "--json")

    expect(result.exitCode).toBe(5)
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "queued" })
  })

  // Guard proof: read a failed thread read as offline in runnerUntilHeld; one 502 while a connected
  // sixb runs another turn starts a second turn beside it, or exits 5 with the computer online.
  test("takes a failed read as knowing nothing about who holds the folder", async () => {
    let reads = 0
    let turn: { send(data: string): void } | undefined
    const { env, claims } = await fakeApi({
      queued: true,
      stream: (socket) => {
        turn = socket
      },
      thread: () => {
        reads += 1
        if (reads === 2) return Response.json({ error: "[Test] Bad gateway." }, { status: 502 })
        if (reads === 3) turn?.send(snapshot("succeeded"))
        return computerThread({ id: "cmp_here", folder: REPOSITORY, online: true })
      },
    })
    await mkdir(join(env.XDG_CONFIG_HOME, "sixb"), { recursive: true })
    await writeFile(join(env.XDG_CONFIG_HOME, "sixb", "computer.json"), '{"id":"cmp_here"}')
    const result = await sendTo(env)

    expect(result.exitCode).toBe(0)
    expect(claims).toEqual([])
  })

  // Guard proof: drop the refusedForGood checks from runnerUntilHeld; once the person loses access
  // or the conversation is deleted, it polls in silence until someone stops it, and a script hangs.
  test.each([401, 403, 404])("exits 3 when the API answers %d for good", async (status) => {
    let reads = 0
    const { env, claims } = await fakeApi({
      queued: true,
      thread: () => {
        reads += 1
        return reads <= 2
          ? computerThread({ id: "cmp_other", folder: "/work/q3", online: true })
          : Response.json({ error: "[Test] Not for you." }, { status })
      },
    })
    const result = await sendTo(env)

    expect(result.exitCode).toBe(3)
    expect(result.stdout + result.stderr).toContain("Not for you.")
    expect(claims).toEqual([])
  })

  describe("in the conversation's own folder", () => {
    const here = async (online: boolean, script: Partial<Script> = {}) => {
      const api = await fakeApi({
        thread: computerThread({ id: "cmp_here", folder: REPOSITORY, online }),
        ...script,
      })
      await mkdir(join(api.config, "sixb"), { recursive: true })
      await writeFile(join(api.config, "sixb", "computer.json"), '{"id":"cmp_here"}')
      return api
    }

    // Guard proof: claim once a moment has passed, as a timer in place of runnerUntilHeld would; a
    // connected sixb busy with another turn would get a second one running beside it in the folder.
    test("leaves the turn to what holds the folder, however long it waits", async () => {
      let reads = 0
      let turn: { send(data: string): void } | undefined
      const { env, claims } = await here(true, {
        queued: true,
        stream: (socket) => {
          turn = socket
        },
        thread: () => {
          // Ends once it has looked more than once, and been left to the holder each time.
          reads += 1
          if (reads === 3) turn?.send(snapshot("succeeded"))
          return computerThread({ id: "cmp_here", folder: REPOSITORY, online: true })
        },
      })
      const result = await sendTo(env)

      expect(result.exitCode).toBe(0)
      expect(claims).toEqual([])
    })

    // Guard proof: read a failed status as the turn having left the queue, in runnerUntilHeld; a
    // network blip after a claim that failed leaves it following a turn nothing will run, for good.
    test("says it couldn't claim the turn when the read after that fails too", async () => {
      let reads = 0
      const { env, claims } = await here(false, {
        queued: true,
        runRead: () => {
          reads += 1
          return reads > 1 ? Response.json({ error: "[Test] Bad gateway." }, { status: 502 }) : null
        },
      })
      const result = await sendTo(env)

      expect(claims).toEqual([RUN])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("couldn't claim")
    })

    // Guard proof: drop the claim from runnerUntilHeld; with nothing connected, the turn waits for a
    // computer this command was to be.
    test("claims the turn itself when nothing holds it, and says if it can't", async () => {
      const { env, claims } = await here(false, { queued: true })
      const result = await sendTo(env)

      expect(claims).toEqual([RUN])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("couldn't claim")
    })
  })
})
