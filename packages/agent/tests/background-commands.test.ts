import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { Sandbox } from "@sixb/core"
import type { AgentMessage } from "@sixb/core/internal/agents"
import { runModelLoop, toModelMessages } from "@sixb/core/internal/agents"
import type {
  LanguageModelRequest,
  LanguageModelStreamEvent,
  ModelMessage,
  ModelTool,
} from "@sixb/core/models"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import {
  type BackgroundCommandOutput,
  type BackgroundCommandState,
  BackgroundCommands,
} from "../src/background-commands"
import { BackgroundNotices, backgroundCommandsLeftRunning } from "../src/background-notices"
import { ComputerRunner, emptyDirectory } from "../src/computer-runner"
import { agentTraceFromModelSteps } from "../src/model-adapters"
import type { OpenRunSandbox } from "../src/run-environment"
import type { AgentSandboxHandle } from "../src/sandbox-handle"
import { createBashOutputTool, createBashStopTool } from "../src/tools/background"
import { createBashTool } from "../src/tools/bash"
import { waitFor } from "./helpers"
import { WorkerTestModel } from "./worker-model-fixture"

// Real commands in a real local sandbox, each a fraction of a second: what is under test is how
// they start, end and are stopped. No isolation backend, so every platform runs the same thing.

let root = ""
let sandbox: Sandbox
let handle: AgentSandboxHandle
let commands: BackgroundCommands
const signal = new AbortController().signal

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sixb-background-")))
  sandbox = await new LocalSandboxFactory({ isolation: "none" }).create({ workingDirectory: root })
  handle = { sandbox, contextDirectory: ".sixb/agent" }
  commands = new BackgroundCommands()
})

afterEach(async () => {
  jest.useRealTimers()
  await commands.stopAll()
  await sandbox.destroy()
  rmSync(root, { recursive: true, force: true })
})

/** One turn of the real event loop, which fake timers leave alone: I/O completes on it. */
function loopTurn(): Promise<void> {
  const { port1, port2 } = new MessageChannel()
  return new Promise((resolve) => {
    port1.onmessage = () => {
      port1.close()
      port2.close()
      resolve()
    }
    port2.postMessage(null)
  })
}

/** Turn the loop, `stepMs` of fake time each, until `done`, or fail after `steps`. */
async function until(done: () => boolean, stepMs: number, steps = 200_000): Promise<void> {
  for (let step = 0; step < steps; step += 1) {
    await loopTurn()
    if (done()) return
    jest.advanceTimersByTime(stepMs)
  }
  throw new Error("[test] It did not settle.")
}

/** Whether a process is gone, its zombie reaped. */
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

describe("background commands", () => {
  test("start, report what they wrote since the last read, and stop", async () => {
    const started = await commands.start({ handle, command: "echo serving; sleep 30" })
    const { id } = started
    expect(started).toMatchObject({
      id: expect.stringMatching(/^bg_[0-9a-f]{6}$/),
      status: "running",
    })
    expect(started.outputPath).toBe(join(root, `.sixb/agent/background/${id}.log`))

    await waitFor(() => readFileSync(started.outputPath, "utf8").includes("serving"))
    expect(await commands.read(id, handle, signal)).toMatchObject({
      status: "running",
      output: "serving\n",
    })
    // Read once: nothing new since.
    expect((await commands.read(id, handle, signal)).output).toBe("")

    const stopped = await commands.stop(id)
    expect(stopped).toMatchObject({ status: "stopped", exitCode: 143 })
    expect(Date.parse(stopped.endedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(started.startedAt))
  })

  test("bound what one read returns, its newest bytes, the rest left in the file", async () => {
    const started = await commands.start({
      handle,
      command: "head -c 50000 /dev/zero | tr '\\0' x; echo; echo END",
    })
    await commands.wait(started.id, 10_000, signal)

    const read = await commands.read(started.id, handle, signal)
    expect(read).toMatchObject({ status: "exited", exitCode: 0, skippedBytes: 50_005 - 20_000 })
    expect(read.output).toHaveLength(20_000)
    expect(read.output.endsWith("x\nEND\n")).toBe(true)
    expect(statSync(started.outputPath).size).toBe(50_005)
  })

  test("wait returns as the command exits", async () => {
    const started = await commands.start({ handle, command: "sleep 0.2; echo done" })
    await commands.wait(started.id, 600_000, signal)

    expect(await commands.read(started.id, handle, signal)).toMatchObject({
      status: "exited",
      exitCode: 0,
      output: "done\n",
    })
  })

  test("wait returns once its bound elapsed, the command still running", async () => {
    const started = await commands.start({ handle, command: "sleep 30" })

    jest.useFakeTimers()
    const waited = commands.wait(started.id, 1_000, signal)
    jest.advanceTimersByTime(1_000)
    await waited

    expect(commands.get(started.id).status).toBe("running")
  })

  test("wait rejects as the run's signal aborts, the command still running", async () => {
    const started = await commands.start({ handle, command: "sleep 30" })
    const abort = new AbortController()

    const waited = commands.wait(started.id, 600_000, abort.signal)
    abort.abort(new Error("stopped"))

    expect(await waited.catch((error: unknown) => error)).toEqual(new Error("stopped"))
    expect(commands.get(started.id).status).toBe("running")
  })

  // Removal proof: signal `$2` rather than `-$2` in signalGroup. The shell exits on SIGTERM and
  // the held call returns, while the `sleep` it started runs on.
  test("stop the whole process group: what the command started dies too", async () => {
    const started = await commands.start({
      handle,
      command: "sleep 30 & echo $! > child.pid; wait",
    })
    await waitFor(() => existsSync(join(root, "child.pid")))
    const child = Number(readFileSync(join(root, "child.pid"), "utf8"))

    expect(await commands.stop(started.id)).toMatchObject({ status: "stopped" })
    await waitFor(() => gone(child), { label: "the command's child exits" })
  })

  // Removal proof: drop the SIGKILL and the abort after the grace period in BackgroundCommands'
  // stop; the stop then waits for a command that ignores SIGTERM forever.
  test("kill a command that ignores SIGTERM once its grace period elapsed", async () => {
    const started = await commands.start({
      handle,
      command: "trap '' TERM; echo ready; while true; do sleep 0.05; done",
    })
    await waitFor(() => readFileSync(started.outputPath, "utf8").includes("ready"))

    jest.useFakeTimers()
    let stopped: BackgroundCommandState | undefined
    const stopping = commands.stop(started.id).then((state) => {
      stopped = state
      return state
    })
    // Its signals go through the sandbox, on the real event loop: turn it, the grace period
    // elapsing in fake time, until the stop returned.
    await until(() => stopped !== undefined, 500)

    expect(await stopping).toMatchObject({ status: "stopped", exitCode: 137 })
  })

  // Removal proof: drop `await entry.started` from BackgroundCommands' #stop. The stop then finds
  // no group yet, aborts the held call, which ends the wrapper alone, and the group runs on.
  test("stop one asked to stop as it starts, its whole group", async () => {
    const starting = commands.start({ handle, command: "sleep 30" })
    await commands.stopAll()

    const started = await starting
    expect(commands.get(started.id)).toMatchObject({ status: "stopped" })
    const group = Number(
      readFileSync(started.outputPath.replace(/\.log$/, ".pid"), "utf8").split(" ")[1]
    )
    await waitFor(() => gone(group), { label: "the command's group exits" })
  })

  // Removal proof: await `started` without the signal in BackgroundCommands' start; the start
  // then returns the command running, as if nothing asked it to stop.
  test("stop one whose start the run's signal aborted", async () => {
    const abort = new AbortController()
    const starting = commands.start({ handle, command: "sleep 30", signal: abort.signal })
    abort.abort(new Error("stopped"))

    expect(await starting.catch((error: unknown) => error)).toEqual(new Error("stopped"))
    expect(commands.list()).toMatchObject([{ status: "stopped" }])
  })

  // Removal proof: label every command ended while its stop runs as stopped in #end; this one
  // caught SIGTERM and exited by itself, with 0.
  test("report how a command ended while its stop ran: by itself here", async () => {
    const started = await commands.start({
      handle,
      command: "trap 'exit 0' TERM; echo ready; while true; do sleep 0.05; done",
    })
    await waitFor(() => readFileSync(started.outputPath, "utf8").includes("ready"))

    expect(await commands.stop(started.id)).toMatchObject({ status: "exited", exitCode: 0 })
  })

  // Removal proof: number ids per index (`bg_1`, `bg_2`…); two runs then both start `bg_1`.
  test("give each command an id no other run gives", async () => {
    const first = await commands.start({ handle, command: "true" })
    const second = await new BackgroundCommands().start({ handle, command: "true" })

    expect(first.id).not.toBe(second.id)
  })

  test("refuse to start in a directory that does not exist, and say why", async () => {
    const refused = await commands
      .start({ handle, command: "true", cwd: "missing" })
      .catch((error: unknown) => error)

    expect(String(refused)).toContain("does not exist")
    expect(commands.list()).toEqual([])
  })
})

describe("background tools", () => {
  test("bash starts one, bash_output waits for it, bash_stop reports one already ended", async () => {
    const bash = createBashTool(async () => handle, commands)
    const output = createBashOutputTool(async () => handle, commands)
    const stop = createBashStopTool(async () => handle, commands)
    const context = { signal, callId: "call", toolCallId: "tool" }

    const started = (await bash.execute(
      bash.parseInput({ command: "sleep 0.1; echo done", run_in_background: true }),
      context
    )) as unknown as BackgroundCommandState
    expect(started).toMatchObject({ status: "running" })
    const { id } = started

    const read = (await output.execute(
      output.parseInput({ id, wait: 900_000 }),
      context
    )) as unknown as BackgroundCommandOutput
    expect(read).toMatchObject({ status: "exited", exitCode: 0, output: "done\n" })

    expect(await stop.execute(stop.parseInput({ id }), context)).toMatchObject({
      status: "exited",
      output: "",
    })
    expect(() => output.parseInput({ id, tail: 3 })).toThrow("unknown property 'tail'")
    expect(
      String(await output.execute({ id: "bg_000000" }, context).catch((error) => error))
    ).toContain(`No background command 'bg_000000': the known ones are ${id}`)
  })
})

describe("background notices", () => {
  /** A model that makes the calls given, one step each, then answers; it keeps each request. */
  function scriptedModel(calls: readonly { readonly name: string; readonly input: object }[]) {
    const requests: LanguageModelRequest[] = []
    const model = new WorkerTestModel()
    model.stream = async (request) => {
      requests.push(request)
      const call = calls[requests.length - 1]
      const events: LanguageModelStreamEvent[] = call
        ? [
            {
              type: "tool-call",
              toolCallId: `call_${requests.length}`,
              toolName: call.name,
              input: JSON.stringify(call.input),
            },
            { type: "finish", finishReason: "tool-calls", usage: {} },
          ]
        : [
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", delta: "Done." },
            { type: "text-end", id: "answer" },
            { type: "finish", finishReason: "stop", usage: {} },
          ]
      return {
        events: (async function* () {
          yield { type: "stream-start" } as const
          yield* events
        })(),
      }
    }
    return { model, requests }
  }

  /** Waits for a background command to end, then returns: the next result after its end. */
  function awaitEnd(): ModelTool {
    return {
      name: "await_end",
      description: "Wait for the first background command.",
      inputSchema: { type: "object" },
      parseInput: (value) => value,
      async execute() {
        const [first] = commands.list()
        if (first) await commands.wait(first.id, 10_000, signal)
        return "waited"
      },
      errorText: () => "failed",
    }
  }

  /** The messages as a provider reads them. */
  function sent(messages: readonly ModelMessage[]): ModelMessage[] {
    return messages.map((message) =>
      message.role === "tool"
        ? {
            ...message,
            content: message.content.map(({ originalOutput: _, ...part }) => part),
          }
        : message
    )
  }

  function toolResults(messages: readonly ModelMessage[]): string[] {
    return messages.flatMap((message) =>
      message.role === "tool"
        ? message.content.map((part) => JSON.stringify(part.output.value))
        : []
    )
  }

  // Removal proof: return `projected` from BackgroundNotices.wrap without the notice; the model
  // is then never told, and the second and third assertions fail.
  test("reach the model in the next result after the command ended, once, and replay as sent", async () => {
    const { model, requests } = scriptedModel([
      { name: "bash", input: { command: "sleep 0.1; echo done", run_in_background: true } },
      { name: "await_end", input: {} },
      { name: "await_end", input: {} },
    ])
    const tools = new BackgroundNotices(commands).wrap([
      createBashTool(async () => handle, commands),
      awaitEnd(),
    ])
    const user: AgentMessage = { role: "user", parts: [{ type: "text", text: "Run it." }] }

    const result = await runModelLoop({
      model,
      messages: toModelMessages([user]),
      tools,
      maxSteps: 5,
      signal,
    })
    expect(result.status).toBe("completed")

    // The command's end closes the result that followed it, and that one only.
    const [started, noticed, after] = toolResults(requests.at(-1)?.messages ?? [])
    expect(started).not.toContain("sixb_background_commands")
    expect(noticed).toMatch(
      /^"waited\\n\\n<sixb_background_commands>\\nBackground command (bg_[0-9a-f]{6}) \(`sleep 0\.1; echo done`\) exited with code 0 after \w+\. Output: .*\/\.sixb\/agent\/background\/\1\.log\\n<\/sixb_background_commands>"$/
    )
    expect(after).toBe('"waited"')

    // A later turn rebuilds the same request from the stored message, as providers read it: the
    // loop's `originalOutput` is its own, never sent.
    const stored: AgentMessage = {
      role: "assistant",
      parts: agentTraceFromModelSteps(result.steps),
    }
    expect(toModelMessages([user, stored])).toEqual([
      ...sent(requests.at(-1)?.messages ?? []),
      ...toModelMessages([{ role: "assistant", parts: [{ type: "text", text: "Done." }] }]),
    ])
  })

  // Removal proof: drop the scan of notices from backgroundCommandsLeftRunning; a run then hears
  // again of a command an earlier notice said ended with its run.
  test("tell a run once of the commands its history left running, ended with their run", () => {
    const call = (toolName: string, output: object, modelOutput?: string) => ({
      type: "tool-call" as const,
      toolCallId: `call_${toolName}`,
      toolName,
      input: {},
      state: "output-available" as const,
      output: output as never,
      ...(modelOutput === undefined
        ? {}
        : { modelOutput: { type: "text" as const, value: modelOutput } }),
    })
    const command = (id: string, status: string) => ({
      id,
      command: `serve ${id}`,
      status,
      startedAt: "2026-11-04T09:00:00.000Z",
      outputPath: `/w/.sixb/agent/background/${id}.log`,
    })
    const paused: AgentMessage = {
      role: "assistant",
      parts: [
        call("bash", command("bg_aaaaaa", "running")),
        call("bash", command("bg_bbbbbb", "running")),
        call("bash_output", { ...command("bg_bbbbbb", "exited"), exitCode: 0, output: "" }),
      ],
    }
    const leftRunning = backgroundCommandsLeftRunning([paused])
    expect(leftRunning.map(({ id }) => id)).toEqual(["bg_aaaaaa"])

    const notice = new BackgroundNotices(commands, { leftRunning }).take()
    expect(notice).toBe(
      "<sixb_background_commands>\nBackground command bg_aaaaaa (`serve bg_aaaaaa`) was stopped when the run that started it ended; its output file is gone.\n</sixb_background_commands>"
    )

    // The run that read it keeps it in its result: the next one is not told again.
    const told: AgentMessage = { role: "assistant", parts: [call("read", {}, `{}\n\n${notice}`)] }
    expect(backgroundCommandsLeftRunning([paused, told])).toEqual([])
  })

  // Removal proof: drop the line of BackgroundCommands' read that marks an end reported; the
  // notice then repeats what bash_output said.
  test("say nothing of a command whose end a tool reported already", async () => {
    const started = await commands.start({ handle, command: "sleep 0.1" })
    await commands.wait(started.id, 10_000, signal)
    await commands.read(started.id, handle, signal)

    expect(new BackgroundNotices(commands).take()).toBeUndefined()
  })
})

describe("background commands on the computer", () => {
  let folder = ""
  let runFilesRoot = ""
  let runner: ComputerRunner
  let changes = 0

  beforeEach(() => {
    changes = 0
    folder = join(root, "folder")
    runFilesRoot = join(root, "runs")
    mkdirSync(folder)
    runner = newRunner()
  })

  afterEach(async () => {
    await runner.stopBackgroundCommands()
    await runner.drain()
  })

  /** A sixb's runner, in the folder: each one opened over the same run files. */
  function newRunner(): ComputerRunner {
    return new ComputerRunner({
      apiUrl: "http://api.localhost",
      authorization: async () => "",
      computer: async () => ({ id: "laptop", name: "Laptop" }),
      folder,
      runFilesRoot,
      onBackgroundChange: () => {
        changes += 1
      },
      openSandbox: ({ workingDirectory, runFiles }) =>
        new LocalSandboxFactory({ isolation: "none", readWritePaths: [runFiles] }).create({
          ...(workingDirectory === undefined ? {} : { workingDirectory }),
        }),
    })
  }

  /** A run's sandbox as the runner opens it: a turn's, in the folder, or a child's. */
  async function open(runId: string, options: { readonly child?: boolean } = {}) {
    const opener = (
      runner as unknown as {
        sandbox(input: {
          readonly runId: string
          readonly threadId: string
          readonly executionToken: string
          readonly projectId: string
          readonly folder?: string
        }): OpenRunSandbox
      }
    ).sandbox({
      runId,
      threadId: "agt_thr_1",
      executionToken: "token",
      projectId: "project",
      ...(options.child ? {} : { folder }),
    })
    const { sandbox: run } = await opener({ signal, onFailure: () => {} })
    const acquired = await run.acquire()
    return {
      run,
      acquired,
      handle: { sandbox: acquired.sandbox, contextDirectory: run.contextDirectory },
    }
  }

  // Removal proofs: destroy the sandbox at once in the runner's release (its stop aborts the held
  // call, which then reads as ended, while the command's own group runs on, out of reach); empty
  // the thread's directory whole as a run starts (its output is lost); stop nothing in
  // stopBackgroundCommands (it runs on after sixb closed).
  test("outlive the turn, its files kept for the next, until sixb closes", async () => {
    const first = await open("agt_run_1")
    const background = first.run.background
    if (!background) throw new Error("A turn on the computer keeps its thread's commands.")

    const started = await background.start({
      handle: first.handle,
      command: "echo serving; sleep 30",
    })
    await first.run.release?.(first.acquired)

    expect(background.get(started.id).status).toBe("running")
    expect(first.acquired.sandbox.status).toBe("running")
    writeFileSync(join(first.run.contextDirectory, "left-behind.txt"), "an earlier run's")

    // The next turn of the thread: its directory emptied but for the commands' files, which it
    // reads through its own sandbox; it hears once of the command still running.
    const second = await open("agt_run_2")
    expect(second.run.background).toBe(background)
    expect(existsSync(join(second.run.contextDirectory, "left-behind.txt"))).toBe(false)
    expect(existsSync(started.outputPath)).toBe(true)

    const notices = new BackgroundNotices(background)
    expect(notices.take()).toContain(
      `Background command ${started.id} (\`echo serving; sleep 30\`) is still running`
    )
    expect(notices.take()).toBeUndefined()

    await waitFor(() => readFileSync(started.outputPath, "utf8").includes("serving"))
    expect((await background.read(started.id, second.handle, signal)).output).toBe("serving\n")
    await second.run.release?.(second.acquired)

    // sixb closes: the command stops, and the sandbox kept for it goes.
    await runner.stopBackgroundCommands()
    expect(background.get(started.id).status).toBe("stopped")
    await runner.drain()
    expect(first.acquired.sandbox.status).toBe("stopped")
  })

  // Removal proofs: drop stopCommandsLeftRunning from the runner's acquire (the group a killed
  // sixb left runs on, its output file removed under it); make `ours` return 0 in REAP_SCRIPT (the
  // process that reused a group id dies too).
  test("stop what a killed sixb left running, never a group that is not its command's", async () => {
    const first = await open("agt_run_1")
    const background = first.run.background
    if (!background) throw new Error("A turn on the computer keeps its thread's commands.")

    const started = await background.start({ handle: first.handle, command: "sleep 30" })
    const pidFile = started.outputPath.replace(/\.log$/, ".pid")
    const group = Number(readFileSync(pidFile, "utf8").split(" ")[1])
    await first.run.release?.(first.acquired)

    // A pid file left earlier, whose group id another process took since: a sleep in a group of
    // its own, re-parented as its shell exits. It sorts first, so the reap meets it first.
    const spawner = Bun.spawn(
      ["bash", "-c", "set -m; sleep 30 < /dev/null > /dev/null 2>&1 & echo $!"],
      { stdout: "pipe" }
    )
    const timer = setTimeout(() => spawner.kill(), 5_000)
    const unrelated = Number((await new Response(spawner.stdout).text()).trim())
    await spawner.exited
    clearTimeout(timer)
    const stale = join(dirname(pidFile), "bg_000000")
    writeFileSync(`${stale}.pid`, `0123456789abcdef ${unrelated}\n`)
    writeFileSync(`${stale}.log`, "")

    // The sixb is killed: the next one opened has an index that knows no command.
    const killed = runner
    runner = newRunner()
    try {
      const second = await open("agt_run_2")
      await waitFor(() => gone(group), { label: "the command's group exits" })
      expect(gone(unrelated)).toBe(false)
      await second.run.release?.(second.acquired)
    } finally {
      if (!gone(unrelated)) process.kill(unrelated, "SIGKILL")
      await killed.stopBackgroundCommands()
      await killed.drain()
    }
  })

  // Removal proofs: compare no start in stopBackgroundCommand (a stop meant for the bg_1 of before
  // a restart stops today's); report no change as a command ends (the web keeps it running).
  test("report each thread's commands, and stop the one the web names", async () => {
    const turn = await open("agt_run_1")
    const background = turn.run.background
    if (!background) throw new Error("A turn on the computer keeps its thread's commands.")

    const quick = await background.start({ handle: turn.handle, command: "exit 3" })
    await background.wait(quick.id, 10_000, signal)
    const served = await background.start({ handle: turn.handle, command: "sleep 30" })
    expect(changes).toBe(3)

    const [running, ended] = runner.backgroundCommands()
    expect(running).toEqual({
      threadId: "agt_thr_1",
      id: served.id,
      command: "sleep 30",
      status: "running",
      startedAt: served.startedAt,
    })
    expect(ended).toMatchObject({ id: quick.id, status: "exited", exitCode: 3 })

    const ref = { threadId: "agt_thr_1", id: served.id }
    expect(
      await runner.stopBackgroundCommand({ ...ref, startedAt: "2026-01-01T00:00:00.000Z" })
    ).toBe(false)
    expect(background.get(served.id).status).toBe("running")
    expect(
      await runner.stopBackgroundCommand({
        ...ref,
        threadId: "agt_thr_other",
        startedAt: served.startedAt,
      })
    ).toBe(false)

    expect(await runner.stopBackgroundCommand({ ...ref, startedAt: served.startedAt })).toBe(true)
    expect(background.get(served.id).status).toBe("stopped")
    expect(changes).toBe(4)
    expect(await runner.stopBackgroundCommand({ ...ref, startedAt: served.startedAt })).toBe(false)

    await turn.run.release?.(turn.acquired)
  })

  // Removal proof: report the command cut with a bare slice; it ends on half the emoji, which
  // Postgres refuses, so every renewal that reports it fails.
  test("report a long command cut between characters, never through an emoji", async () => {
    const turn = await open("agt_run_1")
    const background = turn.run.background
    if (!background) throw new Error("A turn on the computer keeps its thread's commands.")

    // Its 1,000th character is the emoji's first half.
    const echoed = "a".repeat(994)
    const started = await background.start({ handle: turn.handle, command: `echo ${echoed}🚀` })
    await background.wait(started.id, 10_000, signal)

    expect(runner.backgroundCommands()[0]?.command).toBe(`echo ${echoed}`)
    await turn.run.release?.(turn.acquired)
  })

  test("end with a child's run, which keeps none for later", async () => {
    const child = await open("agt_run_child", { child: true })
    expect(child.run.background).toBeUndefined()
    await child.run.release?.(child.acquired)
  })
})

describe("emptyDirectory", () => {
  test("removes everything but the path to keep", async () => {
    const directory = join(root, "thread")
    mkdirSync(join(directory, ".sixb/agent/background"), { recursive: true })
    mkdirSync(join(directory, ".sixb/agent/skills"), { recursive: true })
    writeFileSync(join(directory, ".sixb/agent/background/bg_1.log"), "kept")
    writeFileSync(join(directory, ".sixb/stray"), "removed")
    writeFileSync(join(directory, "stray"), "removed")

    await emptyDirectory(directory, join(directory, ".sixb/agent/background"))
    expect(readFileSync(join(directory, ".sixb/agent/background/bg_1.log"), "utf8")).toBe("kept")
    expect(existsSync(join(directory, ".sixb/agent/skills"))).toBe(false)
    expect(existsSync(join(directory, ".sixb/stray"))).toBe(false)
    expect(existsSync(join(directory, "stray"))).toBe(false)

    await emptyDirectory(directory)
    expect(existsSync(directory)).toBe(false)
  })
})
