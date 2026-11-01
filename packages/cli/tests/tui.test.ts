import { describe, expect, test } from "bun:test"
import type { AgentRunStreamEvent } from "@sixb/client"
import { duration, friendlyPath, shortPath, toolLine } from "../src/tui/format"
import { liveRun, type Part, reduceLive, type StoredMessage, shownMessage } from "../src/tui/parts"
import { type LanguageModel, messageSelection, modelLabel } from "../src/tui/settings"
import { pickSlash, slashMatches } from "../src/tui/slash"

// The app's logic apart from its screens: what a message shows, how a live run builds up, how a
// call reads as one line, what a message is sent with, and which commands a slash names.

const RUN = "agt_run_1"

function event(payload: Record<string, unknown>): AgentRunStreamEvent {
  return { schemaVersion: 1, projectId: "p", runId: RUN, ...payload } as AgentRunStreamEvent
}

describe("a stored message", () => {
  test("shows text, thinking, calls and files, and hides what is the agent's context alone", () => {
    const shown = shownMessage({
      id: "m1",
      threadId: "t",
      projectId: "p",
      seq: 2,
      runId: RUN,
      role: "assistant",
      createdAt: "2026-10-30T00:00:00.000Z",
      contentVersion: 1,
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "Check the CSV first." },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "bash",
          state: "output-available",
          input: { command: "cat visits.csv" },
          output: { exitCode: 0, stdout: "case,site\n" },
        },
        { type: "text", text: "  " },
        { type: "text", text: "Three visits." },
      ],
    } as unknown as StoredMessage)

    expect(shown?.parts.map((part) => part.kind)).toEqual(["reasoning", "tool", "text"])
  })

  test("shows nothing of a resumed turn's trigger, which nobody wrote, but how its calls ended", () => {
    const outcome = {
      type: "approval-outcome",
      approvalId: "apr_1",
      status: "denied",
      call: { kind: "action", actionId: "add-field-note", subject: { kind: "none" } },
    }
    const trigger = (parts: readonly unknown[]) =>
      shownMessage({
        id: "m2",
        role: "user",
        runId: null,
        createdAt: "2026-10-30T00:00:00.000Z",
        parts,
      } as unknown as StoredMessage)

    expect(trigger([outcome])).toMatchObject({
      parts: [],
      outcomes: [{ approvalId: "apr_1", status: "denied" }],
    })
    expect(trigger([])).toBeNull()
  })
})

describe("a live run", () => {
  test("joins text across deltas, starts a new part at each step, and ends with the run", () => {
    let live = liveRun(RUN)
    for (const payload of [
      { type: "agent.ui.chunk", chunk: { type: "text-delta", id: "a", delta: "Looking" } },
      { type: "agent.ui.chunk", chunk: { type: "text-delta", id: "a", delta: " now." } },
      { type: "agent.ui.chunk", chunk: { type: "start-step" } },
      { type: "agent.ui.chunk", chunk: { type: "text-delta", id: "a", delta: "Done." } },
      { type: "agent.run.finished", status: "succeeded" },
    ]) {
      live = reduceLive(live, event(payload))
    }

    expect(live.parts).toEqual([
      { kind: "text", text: "Looking now." },
      { kind: "text", text: "Done." },
    ])
    expect(live).toMatchObject({ working: false, finished: { status: "succeeded" } })
  })

  test("follows a call from its input to its output", () => {
    let live = liveRun(RUN)
    for (const chunk of [
      { type: "tool-input-start", toolCallId: "c1", toolName: "bash" },
      { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '{"command":"ls' },
      {
        type: "tool-input-available",
        toolCallId: "c1",
        toolName: "bash",
        input: { command: "ls" },
      },
    ]) {
      live = reduceLive(live, event({ type: "agent.ui.chunk", chunk }))
    }
    expect(live.parts).toEqual([
      expect.objectContaining({
        kind: "tool",
        name: "bash",
        state: "running",
        input: { command: "ls" },
      }),
    ])

    live = reduceLive(
      live,
      event({
        type: "agent.ui.chunk",
        chunk: { type: "tool-output-available", toolCallId: "c1", output: { exitCode: 0 } },
      })
    )
    expect(live.parts[0]).toMatchObject({ state: "done", output: { exitCode: 0 } })
  })
})

describe("a call as one line", () => {
  const bash = (output: Record<string, unknown>): Extract<Part, { kind: "tool" }> => ({
    kind: "tool",
    id: "c",
    name: "bash",
    state: "done",
    input: { command: "sixb actions request add-field-note --file -" },
    output,
  })

  test("reads a call the API held for approval as waiting, not failed", () => {
    expect(
      toolLine(
        bash({ exitCode: 4, stdout: '{"status":"awaiting_approval","approval":{"id":"apr_1"}}' })
      )
    ).toMatchObject({ held: true, note: "held for your approval" })
    expect(toolLine(bash({ exitCode: 2, stderr: "unknown option" }))).toMatchObject({
      failed: true,
      note: "exit 2",
      preview: ["unknown option"],
    })
  })

  // Guard proof: in toolLine (src/tui/format.ts), read `held` back as
  // `stdout.includes('"status":"awaiting_approval"')`: both outputs read as held, their lines hidden.
  test("holds only a line that names the approval, as the web chat does", () => {
    for (const stdout of [
      'log.jsonl:{"status":"awaiting_approval","approval":{"id":"apr_1"}}',
      '{"status":"awaiting_approval","approval":{}}',
    ]) {
      const line = toolLine(bash({ exitCode: 0, stdout }))

      expect(line.held).toBeUndefined()
      expect(line.preview).toEqual([stdout])
    }
  })

  test("keeps a long output to a few lines, and says how many it left out", () => {
    const stdout = Array.from({ length: 10 }, (_, index) => `row ${index}`).join("\n")
    expect(toolLine(bash({ exitCode: 0, stdout })).preview).toEqual([
      "row 0",
      "row 1",
      "row 2",
      "row 3",
      "… 6 more lines",
    ])
  })
})

describe("what a message is sent with", () => {
  const model = (modelId: string, extra: Partial<LanguageModel> = {}): LanguageModel =>
    ({
      provider: "gateway",
      modelId,
      name: modelId,
      isDefault: false,
      publisher: { id: "x", name: "X" },
      capabilities: { input: ["text"], output: ["text"] },
      reasoningLevels: ["low", "high"],
      ...extra,
    }) as LanguageModel

  test("asks for nothing the person did not choose, so the project's defaults apply", () => {
    const models = [model("a", { isDefault: true }), model("b")]
    const settings = { place: "computer", approvalMode: "manual", continueFromWeb: true } as const
    expect(messageSelection(models, settings)).toEqual({})
    expect(modelLabel(models, settings)).toEqual({ name: "a" })
    expect(
      messageSelection(models, {
        ...settings,
        model: { provider: "gateway", modelId: "b" },
        reasoning: "high",
      })
    ).toEqual({ model: { provider: "gateway", modelId: "b" }, reasoning: "high" })
  })

  test("names Auto when the project picks each message's model by tier", () => {
    const models = [model("a", { tier: "standard" }), model("b", { tier: "heavy" })]
    expect(
      modelLabel(models, { place: "cloud", approvalMode: "auto", continueFromWeb: true })
    ).toEqual({ name: "Auto" })
  })
})

describe("slash commands", () => {
  const commands = ["new", "model", "permissions", "quit"].map((name) => ({
    name,
    description: name,
    run: () => {},
  }))
  const picked = (text: string, chosen?: number) => pickSlash(commands, text, chosen)?.name

  test("runs the command chosen in the menu, the first when none was", () => {
    expect(picked("/")).toBe("new")
    expect(picked("/", 2)).toBe("permissions")
    expect(picked("/pe")).toBe("permissions")
    // A choice past what the text still matches falls back to the last match.
    expect(picked("/m", 3)).toBe("model")
  })

  test("sends anything else to the agent", () => {
    expect(picked("/model gpt")).toBeUndefined()
    expect(picked("what does /model do?")).toBeUndefined()
    expect(picked("/x")).toBeUndefined()
    expect(slashMatches(commands, "/m").map((command) => command.name)).toEqual(["model"])
  })
})

describe("formatting", () => {
  test("never shows sixty seconds", () => {
    expect(duration(59_960)).toBe("1m 00s")
    expect(duration(179_600)).toBe("3m 00s")
    expect(duration(12_400)).toBe("12.4s")
  })

  test("names paths from the folder the agent works in, and the run's own files as run/", () => {
    expect(friendlyPath("/Users/me/work/q3/report.md", "/Users/me/work/q3")).toBe("report.md")
    expect(
      friendlyPath(
        "/private/var/folders/g5/x/T/sixb-agent/agt_run_1/.sixb/agent/children/totals/out.md",
        "/Users/me/work/q3"
      )
    ).toBe("run/children/totals/out.md")
  })

  test("shortens a path to what fits, keeping its last folder", () => {
    expect(shortPath("/Users/me/work/q3-close", "/Users/me", 40)).toBe("~/work/q3-close")
    expect(shortPath("/Users/me/a/b/c/d/q3-close", "/Users/me", 16)).toBe("~/a/…/q3-close")
    expect(shortPath("/Users/me/a/b/c/d/q3-close", "/Users/me", 12)).toBe("…/q3-close")
  })
})
