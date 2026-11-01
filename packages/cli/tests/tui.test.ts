import { describe, expect, test } from "bun:test"
import type { AgentRunStreamEvent } from "@sixb/client"
import {
  contextStatus,
  duration,
  fittedContextText,
  friendlyPath,
  runFailureText,
  shortPath,
  toolLine,
} from "../src/tui/format"
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

  // Reproduce: let reduceChunk handle a retried start-step as any other; the first call's text
  // then stays above the answer.
  test("drops what a step's first call streamed when the step is asked again", () => {
    let live = liveRun(RUN)
    for (const chunk of [
      { type: "start-step" },
      { type: "text-delta", id: "a", delta: "Reading." },
      { type: "start-step" },
      { type: "text-delta", id: "a", delta: "Half an ans" },
      { type: "start-step", retry: true },
      { type: "text-delta", id: "a", delta: "The answer." },
    ]) {
      live = reduceLive(live, event({ type: "agent.ui.chunk", chunk }))
    }

    expect(live.parts).toEqual([
      { kind: "text", text: "Reading." },
      { kind: "text", text: "The answer." },
    ])
  })

  // Reproduce: leave `contextFull` false when a compaction starts; a turn the provider refused
  // reads "Condensing earlier turns" like any other.
  test("tells a compaction after a refused request from one at the limit", () => {
    const full = reduceLive(
      liveRun(RUN),
      event({ type: "agent.compaction.started", reason: "overflow", estimatedInputTokensBefore: 1 })
    )
    expect(full).toMatchObject({ compacting: true, contextFull: true })

    const threshold = reduceLive(
      liveRun(RUN),
      event({
        type: "agent.compaction.started",
        reason: "threshold",
        estimatedInputTokensBefore: 1,
      })
    )
    expect(threshold).toMatchObject({ compacting: true, contextFull: false })
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
    const settings = { place: "computer", approvalMode: "manual" } as const
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
    expect(modelLabel(models, { place: "cloud", approvalMode: "auto" })).toEqual({ name: "Auto" })
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

describe("a stored answer", () => {
  // Reproduce: drop `compaction` from shownMessage; the transcript never says it was condensed.
  test("says its run condensed the conversation, and when it was because the context was full", () => {
    const answer = (reason?: "threshold" | "overflow"): StoredMessage => ({
      id: "msg_answer",
      projectId: "p",
      threadId: "thr",
      runId: RUN,
      role: "assistant",
      seq: 4,
      parts: [{ type: "text", text: "Done." }],
      annotations: [],
      ...(reason
        ? {
            compaction: {
              checkpointId: "ctx",
              reason,
              summary: "Earlier.",
              createdAt: "2026-11-01T09:00:00.000Z",
            },
          }
        : {}),
      contentVersion: 1,
      createdAt: "2026-11-01T09:00:01.000Z",
    })

    expect(shownMessage(answer("threshold"))?.compaction).toEqual({ contextFull: false })
    expect(shownMessage(answer("overflow"))?.compaction).toEqual({ contextFull: true })
    expect(shownMessage(answer())).not.toHaveProperty("compaction")
  })
})

describe("the context in the status line", () => {
  const haiku = {
    limitTokens: 183_616,
    usedTokens: 38_200,
    lastCall: { inputTokens: 37_000, cacheReadInputTokens: 34_040 },
  }

  test("reads used against the model's limit with the cache share, and colors by it", () => {
    expect(contextStatus(haiku)).toEqual({
      text: "ctx 38k/184k · 92% cached",
      short: "ctx 38k/184k",
      tone: "quiet",
    })
    expect(contextStatus({ ...haiku, usedTokens: 150_000 })?.tone).toBe("near")
    expect(contextStatus({ ...haiku, usedTokens: 190_000 })?.tone).toBe("over")
  })

  test("shows nothing before the first answer", () => {
    expect(contextStatus({ limitTokens: 183_616 })).toBeUndefined()
  })

  // Reproduce: always return the whole text; a narrow terminal wraps the status line.
  test("drops the cache share, then itself, where the status line has no room", () => {
    const context = contextStatus(haiku)!
    // "Cloud · Claude Haiku 4.5 · Ask first" takes 36 columns.
    expect(fittedContextText(context, 36, 100)).toBe("ctx 38k/184k · 92% cached")
    expect(fittedContextText(context, 36, 60)).toBe("ctx 38k/184k")
    expect(fittedContextText(context, 36, 45)).toBeUndefined()
  })
})

describe("formatting", () => {
  test("a conversation too long for its model names the commands that go on", () => {
    // Removal proof: print run.error.message for every code in the run line.
    expect(
      runFailureText({
        code: "agent.context_limit_exceeded",
        message: "This conversation is too long for the model's context window.",
      })
    ).toBe(
      "This conversation is too long for the model: /new starts another, /model picks a larger one."
    )
    expect(
      runFailureText({ code: "agent.execution_failed", message: "Agent execution failed." })
    ).toBe("Agent execution failed.")
  })

  test("never shows sixty seconds", () => {
    expect(duration(59_960)).toBe("1m 00s")
    expect(duration(179_600)).toBe("3m 00s")
    expect(duration(12_400)).toBe("12.4s")
  })

  test("names paths from the folder the agent works in, and the run's own files as run/", () => {
    expect(friendlyPath("/Users/me/work/q3/report.md", "/Users/me/work/q3")).toBe("report.md")
    expect(
      friendlyPath(
        "/private/var/folders/g5/x/T/sixb-agent/agt_run_1/children/totals/out.md",
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
