import { afterEach, describe, expect, jest, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DesktopRunner, type RunnerProcess, runnerEnvironment } from "../src/shell/runner"

const cleanups: (() => Promise<unknown>)[] = []

afterEach(async () => {
  jest.useRealTimers()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function fakeProcess() {
  let exit = (_code: number) => {}
  let listen = (_line: string) => {}
  const written: unknown[] = []
  let ended = false
  let killed = false
  const process: RunnerProcess = {
    onLine: (listener) => {
      listen = listener
    },
    exited: new Promise((resolve) => {
      exit = resolve
    }),
    write: (line) => written.push(JSON.parse(line)),
    end: () => {
      ended = true
    },
    kill: () => {
      killed = true
    },
  }
  return {
    process,
    written,
    say: (event: unknown) => listen(JSON.stringify(event)),
    exit: (code: number) => exit(code),
    ended: () => ended,
    killed: () => killed,
  }
}

function runner() {
  const started: ReturnType<typeof fakeProcess>[] = []
  const signIns: string[] = []
  const problems: string[] = []
  const desktop = new DesktopRunner({
    start: () => {
      const next = fakeProcess()
      started.push(next)
      return next.process
    },
    onSignIn: (url) => signIns.push(url),
    onProblem: (message) => problems.push(message),
  })
  return { desktop, started, signIns, problems }
}

/** Turns of the loop for what follows a process's exit to run; no clock is involved. */
async function settled() {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
}

describe("the runner, from the shell's main process", () => {
  // Guard proof: answer about() with null until the runner has spoken; the page takes this computer
  // for one that can't run the agent, whenever it asks first.
  test("answers what computer this is once the runner says", async () => {
    const { desktop, started } = runner()
    desktop.start()
    const about = desktop.about()
    started[0]?.say({ type: "computer", id: "cmp_1", name: "Ava's Mac" })

    expect(await about).toEqual({ id: "cmp_1", name: "Ava's Mac" })
    expect(await desktop.about()).toEqual({ id: "cmp_1", name: "Ava's Mac" })
  })

  // Guard proof: drop `unsent` and write only to a running process; a folder picked during a restart
  // is shown as chosen and never takes a message.
  test("hands over what was chosen while it wasn't running", async () => {
    jest.useFakeTimers()
    const { desktop, started } = runner()
    desktop.start()
    started[0]?.exit(1)
    await settled()

    desktop.allow("/work/notes")
    expect(await desktop.folders()).toEqual(["/work/notes"])

    jest.advanceTimersByTime(2_000)
    expect(started[1]?.written).toEqual([{ type: "allow", folder: "/work/notes" }])
  })

  // Guard proof: restart at once whatever the exit code; a runner that can't start spins the CPU.
  test("restarts after a wait that grows, whatever it exited with", async () => {
    jest.useFakeTimers()
    const { desktop, started, problems } = runner()
    desktop.start()

    // A sign-in that ended is no problem to report, and no reason to spin if it keeps ending.
    started[0]?.exit(3)
    await settled()
    expect(started).toHaveLength(1)
    expect(problems).toEqual([])
    jest.advanceTimersByTime(1_999)
    expect(started).toHaveLength(1)
    jest.advanceTimersByTime(1)
    expect(started).toHaveLength(2)

    started[1]?.exit(1)
    await settled()
    expect(problems).toHaveLength(1)
    jest.advanceTimersByTime(3_999)
    expect(started).toHaveLength(2)
    jest.advanceTimersByTime(1)
    expect(started).toHaveLength(3)
  })

  // Guard proof: answer folders() at once; a page asking as the app opens finds none, and asks the
  // person for a folder they chose long ago.
  test("answers the folders once the runner knows them, or knows it can't yet", async () => {
    const known = runner()
    known.desktop.start()
    const folders = known.desktop.folders()
    known.started[0]?.say({ type: "folders", folders: ["/work/notes"] })
    expect(await folders).toEqual(["/work/notes"])

    const signedOut = runner()
    signedOut.desktop.start()
    const none = signedOut.desktop.folders()
    signedOut.started[0]?.say({ type: "signed-out-waiting" })
    expect(await none).toEqual([])
  })

  // Guard proof: restart once stopped too; quitting the app starts it again behind the person's back.
  test("stops by closing its stdin, and stays stopped", async () => {
    jest.useFakeTimers()
    const { desktop, started } = runner()
    desktop.start()

    const stopped = desktop.stop()
    expect(started[0]?.ended()).toBe(true)
    started[0]?.exit(0)
    await stopped
    await settled()
    jest.advanceTimersByTime(60_000)

    expect(started[0]?.killed()).toBe(false)
    expect(started).toHaveLength(1)
  })

  // Guard proof: await the exit with no limit in stop; a runner stuck on its way out keeps the app
  // from quitting, with no window left to say so.
  test("kills it when it doesn't stop in time", async () => {
    jest.useFakeTimers()
    const { desktop, started } = runner()
    desktop.start()

    const stopped = desktop.stop()
    jest.advanceTimersByTime(12_000)
    await stopped

    expect(started[0]?.killed()).toBe(true)
  })

  test("passes on where to approve a sign-in", () => {
    const { desktop, started, signIns } = runner()
    desktop.start()
    started[0]?.say({ type: "sign-in", url: "https://api.acme.test/auth/device", userCode: "AB" })
    expect(signIns).toEqual(["https://api.acme.test/auth/device"])
  })
})

describe("the runner's environment", () => {
  // Guard proof: drop `detached` from loginShellPath; an interactive shell takes over the terminal the
  // app inherited, and `sixb dev --desktop` is stopped, "suspended (tty input)", at the next mouse move.
  // A shell alone in its process group is one in a session of its own, with no terminal to take.
  test("asks the person's shell for its PATH away from any terminal", async () => {
    const root = await mkdtemp(join(tmpdir(), "sixb-desktop-shell-"))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const shell = join(root, "shell")
    await writeFile(
      shell,
      '#!/bin/sh\n[ "$(ps -o pgid= -p $$ | tr -d " ")" = "$$" ] && printf "__SIXB_PATH__/from/shell__SIXB_PATH__"\n',
      { mode: 0o755 }
    )

    const env = await runnerEnvironment("/app/runner", { SHELL: shell, PATH: "/usr/bin" })

    expect(env.PATH).toBe("/from/shell:/app/runner")
  })

  // Guard proof: rely on execFile's own timeout in loginShellPath; a .zshrc that attaches tmux or waits
  // on a read never gives way, so the runner never starts and every conversation goes to the cloud.
  test("doesn't wait on a shell that never answers", async () => {
    const root = await mkdtemp(join(tmpdir(), "sixb-desktop-shell-"))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const shell = join(root, "stuck-shell")
    await writeFile(shell, "#!/bin/sh\ntrap '' TERM\nsleep 30\n", { mode: 0o755 })

    jest.useFakeTimers()
    const env = runnerEnvironment("/app/runner", { SHELL: shell, PATH: "/usr/bin" })
    jest.advanceTimersByTime(3_000)

    expect((await env).PATH).toBe("/usr/bin:/app/runner")
  })

  // Guard proof: put the runner's directory first; the program stands in for a person's own Bun, in
  // every command the agent runs.
  test("adds its bun last, after what the person has, and none of a terminal's project", async () => {
    const env = await runnerEnvironment("/app/runner", {
      SHELL: "/no/such/shell",
      PATH: "/usr/bin:/opt/homebrew/bin",
      HOME: "/Users/ava",
      SIXB_API_URL: "http://localhost:3001",
      SIXB_API_TOKEN: "sixb_pat_other",
    })

    expect(env.PATH).toBe("/usr/bin:/opt/homebrew/bin:/app/runner")
    expect(env.HOME).toBe("/Users/ava")
    expect(Object.keys(env).filter((name) => name.startsWith("SIXB_"))).toEqual([])
  })
})
