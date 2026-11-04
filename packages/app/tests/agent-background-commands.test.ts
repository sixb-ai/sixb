import { describe, expect, test } from "bun:test"
import { latestWorkLabel } from "../src/agent/activity-label"
import {
  type BackgroundSource,
  type BackgroundStart,
  backgroundCardState,
  backgroundKey,
  backgroundStartOf,
  type LiveBackgroundCommand,
  readThreadBackground,
} from "../src/agent/background/interpret"
import type { AgentConversationMessage } from "../src/agent/conversation"
import type { NormalizedTool } from "../src/agent/parts"

// A background command reads as one card: its start, the agent's later reads and stops, maybe
// turns later, what the owner's sixb reports between turns, and whether its turn still works.

const STARTED = "2026-11-04T10:00:00.000Z"
const ID = "bg_1a2b3c"
const KEY = backgroundKey({ id: ID, startedAt: STARTED })
const STATE = {
  id: ID,
  command: "bun run dev",
  status: "running",
  startedAt: STARTED,
  outputPath: "/tmp/.sixb/agent/background/bg_1a2b3c.log",
}

type Part = AgentConversationMessage["parts"][number]

function tool(
  toolName: string,
  input: Record<string, unknown>,
  output?: Record<string, unknown>
): Part {
  return {
    type: "tool",
    toolCallId: `call_${toolName}_${JSON.stringify(output ?? input).length}`,
    toolName,
    ...(output === undefined
      ? { state: "input-available", input }
      : { state: "output-available", input, output }),
  } as Part
}

function reply(runId: string, parts: readonly Part[]) {
  return { role: "assistant" as const, runId, parts }
}

const start = tool("bash", { command: "bun run dev", run_in_background: true }, STATE)
const started: BackgroundStart = {
  kind: "started",
  key: KEY,
  id: ID,
  startedAt: STARTED,
  command: "bun run dev",
}
const cloud: BackgroundSource = { onComputer: false, live: null, online: false }
const computer = (live: readonly LiveBackgroundCommand[], online = true): BackgroundSource => ({
  onComputer: true,
  live,
  online,
})

describe("a background command's calls", () => {
  // Guard proof: let a later read's status replace an end in readThreadBackground; the card of a
  // command the agent saw exit reads as running again.
  test("read as one command, its output gathered, its end final", () => {
    const thread = readThreadBackground([
      reply("run_1", [start, tool("bash_output", { id: ID }, { ...STATE, output: "ready\n" })]),
      reply("run_2", [
        tool(
          "bash_output",
          { id: ID },
          {
            ...STATE,
            status: "exited",
            exitCode: 1,
            endedAt: "2026-11-04T10:02:00.000Z",
            output: "crashed\n",
          }
        ),
        tool("bash_output", { id: ID }, { ...STATE, output: "" }),
      ]),
    ])

    expect(thread.commands.get(KEY)).toMatchObject({
      command: "bun run dev",
      runId: "run_1",
      status: "exited",
      exitCode: 1,
      output: "ready\ncrashed\n",
      truncated: false,
    })
  })

  test("say what the agent does with it now", () => {
    const stopping = readThreadBackground([reply("run_1", [start, tool("bash_stop", { id: ID })])])
    expect(stopping.commands.get(KEY)?.pending).toBe("stopping")

    const waiting = readThreadBackground([
      reply("run_1", [start, tool("bash_output", { id: ID, wait: 60_000 })]),
    ])
    expect(waiting.commands.get(KEY)?.pending).toBe("waiting")
  })

  test("stand for the command its start started, not for a start that failed", () => {
    const bash = (tool: Partial<NormalizedTool>): NormalizedTool => ({
      toolName: "bash",
      state: "output-available",
      ...tool,
    })

    expect(
      backgroundStartOf(
        bash({ input: { command: "bun run dev", run_in_background: true }, output: STATE })
      )
    ).toEqual(started)
    expect(
      backgroundStartOf(
        bash({
          state: "input-available",
          input: { command: "bun test --watch", run_in_background: true },
        })
      )
    ).toEqual({ kind: "starting", key: "starting", command: "bun test --watch" })
    expect(backgroundStartOf(bash({ input: { command: "ls" }, output: { exitCode: 0 } }))).toBe(
      null
    )
    expect(
      backgroundStartOf(
        bash({
          state: "output-error",
          input: { command: "nope", run_in_background: true },
          errorText: "No such directory",
        })
      )
    ).toBe(null)
  })

  test("name what the turn is doing while it works", () => {
    expect(
      latestWorkLabel([
        {
          kind: "tool",
          tool: {
            toolName: "bash_output",
            state: "input-available",
            input: { id: ID, wait: 5_000 },
          },
        },
      ])
    ).toBe("Waiting for a background command")
    expect(
      latestWorkLabel([
        {
          kind: "tool",
          tool: {
            toolName: "bash",
            state: "input-available",
            input: { command: "bun run dev", run_in_background: true },
          },
        },
      ])
    ).toBe("Starting in the background")
  })
})

describe("a background command's card", () => {
  const calls = readThreadBackground([reply("run_1", [start])]).commands.get(KEY)
  const card = (source: BackgroundSource, liveRunId: string | null, extra = {}) =>
    backgroundCardState({
      start: started,
      ...(calls ? { calls } : {}),
      source,
      liveRunId,
      ...extra,
    })

  // Guard proof: drop the cloud branch of backgroundCardState; a command that ended with its turn
  // in the cloud reads as last seen running, as if it might still run.
  test("in the cloud, runs while its turn works and stops with it, with no Stop", () => {
    expect(card(cloud, "run_1")).toMatchObject({ status: "running", canStop: false })
    expect(card(cloud, null)).toMatchObject({
      status: "stopped",
      endedWith: "turn",
      canStop: false,
    })
  })

  // Guard proof: offer Stop while its turn works but before its sixb reported it; the API has no
  // such command yet and answers 404.
  test("on its owner's computer, stands as its sixb reports it, Stop while it runs there", () => {
    const live = { ...STATE, status: "running" as const }
    expect(card(computer([live]), null)).toMatchObject({ status: "running", canStop: true })
    expect(card(computer([{ ...live, stopping: true }]), null)).toMatchObject({
      status: "running",
      stopping: true,
      canStop: false,
    })
    expect(card(computer([live]), null, { stopAsked: true })).toMatchObject({
      stopping: true,
      canStop: false,
    })
    expect(
      card(
        computer([{ ...live, status: "exited", exitCode: 1, endedAt: "2026-11-04T10:05:00.000Z" }]),
        null
      )
    ).toMatchObject({
      status: "exited",
      exitCode: 1,
      endedAt: "2026-11-04T10:05:00.000Z",
      canStop: false,
    })

    // Its turn still works and its sixb has not reported it yet: it runs.
    expect(card(computer([]), "run_1")).toMatchObject({ status: "running", canStop: false })
  })

  // Guard proof: read an offline sixb as one that no longer runs it; a command that runs on while
  // messages from the web are off reads as stopped.
  test("on its owner's computer, gone once its open sixb no longer reports it, unknown while closed", () => {
    expect(card(computer([]), null)).toMatchObject({ status: "stopped", endedWith: "sixb" })
    expect(card(computer([], false), null)).toMatchObject({ status: "unknown", unreachable: true })
  })

  test("on someone else's computer, last seen running", () => {
    const elsewhere: BackgroundSource = { onComputer: true, live: null, online: false }
    expect(card(elsewhere, null)).toMatchObject({ status: "unknown", canStop: false })
    expect(card(elsewhere, null)).not.toHaveProperty("unreachable")
  })

  test("ended by the agent's own read, whatever the computer last said", () => {
    const thread = readThreadBackground([
      reply("run_1", [
        start,
        tool("bash_stop", { id: ID }, { ...STATE, status: "stopped", exitCode: 143, output: "" }),
      ]),
    ])
    const state = backgroundCardState({
      start: started,
      calls: thread.commands.get(KEY),
      source: computer([{ ...STATE, status: "running" }]),
      liveRunId: null,
    })
    expect(state).toMatchObject({ status: "stopped", exitCode: 143, canStop: false })
    expect(state).not.toHaveProperty("endedWith")
  })
})
