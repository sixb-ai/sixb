import { describe, expect, test } from "bun:test"
import type { AgentRunStreamEvent } from "@sixb/client"
import {
  backgroundEnded,
  backgroundStrip,
  contextBreakdown,
  contextStatus,
  duration,
  elapsed,
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

describe("a file the agent read or changed", () => {
  const call = (
    name: string,
    input: Record<string, unknown>,
    output: Record<string, unknown>
  ): Extract<Part, { kind: "tool" }> => ({
    kind: "tool",
    id: "c",
    name,
    state: "done",
    input,
    output,
  })

  // Removal proof: drop the edit case from toolLine; the line then shows the call's JSON.
  test("an edit shows what it added and removed, its changed lines colored", () => {
    expect(
      toolLine(
        call(
          "edit",
          { path: "src/app.ts", old_string: "3", new_string: "5" },
          { path: "src/app.ts", replaced: 1, diff: "@@ -1,2 +1,2 @@\n-x = 3\n+x = 5\n \n" }
        )
      )
    ).toEqual({
      verb: "edit",
      detail: "src/app.ts",
      note: "+1 −1",
      diff: true,
      preview: ["-x = 3", "+x = 5"],
    })
  })

  // Reproduce: count added and removed from the diff alone in toolLine; the line then shows +1 −1.
  test("a large edit counts all the lines it changed, though its diff was cut", () => {
    const edit = (counts: Record<string, number>) =>
      toolLine(
        call(
          "edit",
          { path: "src/app.ts", old_string: "a", new_string: "b", replace_all: true },
          {
            path: "src/app.ts",
            replaced: 40,
            diff: "@@ -1 +1 @@\n-a\n+b\n… 39 more hunks\n",
            ...counts,
          }
        )
      )
    expect(edit({ added: 40, removed: 40 })).toMatchObject({ note: "+40 −40" })
    // Stored before an edit counted its lines, as an old thread replays it: the diff is counted.
    expect(edit({})).toMatchObject({ note: "+1 −1" })
  })

  test("a write says whether it created or rewrote the file, and how long it is", () => {
    const write = (created: boolean) =>
      toolLine(call("write", { path: "a.md" }, { path: "a.md", created, lines: 3, bytes: 9 }))
    expect(write(true)).toEqual({ verb: "write", detail: "a.md", note: "3 lines" })
    expect(write(false)).toMatchObject({ verb: "rewrite" })
  })

  test("a read of a folder lists, and of an image views", () => {
    expect(toolLine(call("read", { path: "src" }, { path: "src", entries: ["a", "b/"] }))).toEqual({
      verb: "list",
      detail: "src",
      note: "2 entries",
    })
    expect(
      toolLine(call("read", { path: "out/chart.png" }, { kind: "agentToolResult", content: [] }))
    ).toEqual({ verb: "view", detail: "out/chart.png" })
  })
})

describe("a background command", () => {
  const started = "2026-11-04T10:00:00.000Z"
  const at = (seconds: number) => Date.parse(started) + seconds * 1_000
  const call = (
    name: string,
    input: Record<string, unknown>,
    output: Record<string, unknown>
  ): Extract<Part, { kind: "tool" }> => ({
    kind: "tool",
    id: "c",
    name,
    state: "done",
    input,
    output,
  })

  test("reads as started, checked and stopped, with how it stands", () => {
    const start = toolLine(
      call(
        "bash",
        { command: "bun run dev", run_in_background: true },
        { id: "bg_1a2b3c", status: "running", startedAt: started }
      )
    )
    expect(start).toMatchObject({ verb: "bash", note: "in the background · bg_1a2b3c" })
    expect(start).not.toHaveProperty("failed")

    const read = { id: "bg_1a2b3c", command: "bun test", startedAt: started }
    expect(
      toolLine(
        call(
          "bash_output",
          { id: "bg_1a2b3c" },
          { ...read, status: "exited", exitCode: 1, output: "1 fail\n" }
        )
      )
    ).toMatchObject({
      verb: "output",
      detail: "bg_1a2b3c  bun test",
      note: "exit 1",
      failed: true,
      preview: ["1 fail"],
    })
    expect(
      toolLine(
        call(
          "bash_stop",
          { id: "bg_1a2b3c" },
          { ...read, status: "stopped", exitCode: 143, output: "" }
        )
      )
    ).toEqual({ verb: "stop", detail: "bg_1a2b3c  bun test", note: "stopped" })
  })

  test("ticks by the second while it runs", () => {
    expect([elapsed(800), elapsed(8_400), elapsed(134_000), elapsed(3_780_000)]).toEqual([
      "0s",
      "8s",
      "2m 14s",
      "1h 03m",
    ])
  })

  // Guard proof: drop the room check from backgroundStrip; four commands overflow a phone-narrow
  // terminal's line instead of folding into "+N more".
  test("lists the running ones over the composer, as many as fit", () => {
    const running = (id: string, command: string, offset: number) => ({
      id,
      command,
      status: "running" as const,
      startedAt: new Date(at(offset)).toISOString(),
    })
    const commands = [
      running("bg_b", "bun test --watch", 60),
      running("bg_a", "bun run dev --port 3000", 0),
      { ...running("bg_c", "make docs", 10), status: "exited" as const, exitCode: 0 },
      running("bg_d", "tail -f logs/server.log", 90),
      running("bg_e", "python -m http.server", 100),
    ]

    expect(backgroundStrip(commands, at(134), 200)).toEqual({
      shown: [
        { label: "bun run dev --port 3000", time: "2m 14s" },
        { label: "bun test --watch", time: "1m 14s" },
        { label: "tail -f logs/server.log", time: "44s" },
        { label: "python -m http.server", time: "34s" },
      ],
      more: 0,
    })
    const narrow = backgroundStrip(commands, at(134), 72)
    expect(narrow.shown.map((entry) => entry.label)).toEqual([
      "bun run dev --port 3000",
      "bun test --watch",
    ])
    expect(narrow.more).toBe(2)
  })

  test("says how it ended", () => {
    const ended = { id: "bg_a", command: "bun test", startedAt: started }
    const endedAt = new Date(at(42)).toISOString()
    expect(backgroundEnded({ ...ended, status: "exited", exitCode: 0, endedAt })).toEqual({
      text: "bun test exited with code 0 after 42s",
      failed: false,
    })
    expect(backgroundEnded({ ...ended, status: "exited", exitCode: 1, endedAt }).failed).toBe(true)
    expect(backgroundEnded({ ...ended, status: "stopped", exitCode: 143, endedAt }).text).toBe(
      "bun test stopped after 42s"
    )
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

  // Guard proof: in toolLine (src/tui/format.ts), drop the `timedOut` branch of the note, or read
  // stderr whole; the line then says `exit 137`, or previews the sentence meant for the model.
  test("says how long a timed-out command had, not its exit code or the model's notice", () => {
    const notice =
      "[SixbAgent] The command was stopped after 2 minutes, its timeout. Pass a larger timeoutMs, up to 600000, to give it longer."
    const timedOut = (input: Record<string, unknown>, stderr: string) =>
      toolLine({
        ...bash({ exitCode: 137, timedOut: true, stdout: "building…\n", stderr }),
        input: { command: "bun run build", ...input },
      })

    expect(timedOut({}, notice)).toMatchObject({
      failed: true,
      note: "timed out after 2 min",
      preview: ["building…"],
    })
    expect(timedOut({ timeoutMs: 300_000 }, `warning: slow\n${notice}`)).toMatchObject({
      note: "timed out after 5 min",
      preview: ["warning: slow"],
    })
    expect(timedOut({ timeoutMs: 90_000 }, notice).note).toBe("timed out after 90 s")
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

describe("a web call as one line", () => {
  const web = (
    name: "web_search" | "web_fetch",
    input: Record<string, unknown>,
    output?: Record<string, unknown>
  ): Extract<Part, { kind: "tool" }> => ({
    kind: "tool",
    id: "w",
    name,
    state: output ? "done" : "running",
    input,
    output,
  })

  test("names a search by its query and how many results came back", () => {
    const query = { query: "bun 1.4 release notes" }
    const hit = { url: "https://bun.sh/blog", title: "Bun", snippet: "…" }

    expect(toolLine(web("web_search", query))).toEqual({
      verb: "search",
      detail: "bun 1.4 release notes",
    })
    expect(toolLine(web("web_search", query, { query: query.query, results: [hit, hit] }))).toEqual(
      {
        verb: "search",
        detail: "bun 1.4 release notes",
        note: "2 results",
      }
    )
    expect(toolLine(web("web_search", query, { results: [{ ...hit, text: "Exa" }] })).note).toBe(
      "1 result"
    )
  })

  test("names a page by host and path, then says what came of it", () => {
    const input = { url: "https://docs.example.com/guide/start?ref=nav#install" }
    const page = {
      source: { url: input.url, title: "Start" },
      status: 200,
      contentType: "text/html",
      bytes: 122_880,
    }

    expect(toolLine(web("web_fetch", input))).toEqual({
      verb: "fetch",
      detail: "docs.example.com/guide/start",
    })
    expect(toolLine(web("web_fetch", { url: "https://example.com/" }, page)).detail).toBe(
      "example.com"
    )
    expect(toolLine(web("web_fetch", input, { ...page, preview: "# Start" })).note).toBeUndefined()
    expect(
      toolLine(web("web_fetch", input, { ...page, question: "How?", answer: "Like this." })).note
    ).toBe("answered")
    expect(toolLine(web("web_fetch", input, { ...page, path: "/w/page.md" })).note).toBe(
      "saved 120 KB"
    )
    expect(
      toolLine(
        web("web_fetch", input, {
          ...page,
          status: 301,
          redirect: { url: "https://other.host/start", status: 301 },
        })
      ).note
    ).toBe("→ other.host")
  })

  // Regression proof: spread the generic `error` into the web_fetch line instead of
  // `fetchFailure`; the note is then the whole error, and the address has no room left.
  test("says why a read failed in a word, and the error under the line", () => {
    const failed = (error: string): Extract<Part, { kind: "tool" }> => ({
      kind: "tool",
      id: "w",
      name: "web_fetch",
      state: "error",
      input: { url: "https://docs.example.com/guide/start" },
      error,
    })
    const blocked =
      "[SixbAgent] Blocked: https://docs.example.com/guide/start is outside the domains this project's agent may read."

    expect(toolLine(failed(blocked))).toEqual({
      verb: "fetch",
      detail: "docs.example.com/guide/start",
      note: "blocked",
      failed: true,
      preview: [blocked.slice("[SixbAgent] ".length)],
    })
    expect(
      toolLine(failed("[SixbAgent] Could not fetch https://docs.example.com/ (ECONNREFUSED).")).note
    ).toBe("refused")
    expect(
      toolLine(failed("[SixbAgent] Timed out after 30 s fetching https://docs.example.com/.")).note
    ).toBe("timed out")
    expect(
      toolLine(failed("[SixbAgent] Could not resolve 'docs.example.com' (ENOTFOUND).")).note
    ).toBe("failed")
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
    const settings = {
      place: "computer",
      approvalMode: "manual",
      continueFromWeb: true,
      keepAwake: true,
    } as const
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
      modelLabel(models, {
        place: "cloud",
        approvalMode: "auto",
        continueFromWeb: true,
        keepAwake: true,
      })
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
      shortest: "ctx 21%",
      tone: "quiet",
    })
    expect(contextStatus({ ...haiku, usedTokens: 150_000 })?.tone).toBe("near")
    expect(contextStatus({ ...haiku, usedTokens: 190_000 })?.tone).toBe("over")
  })

  test("shows nothing before the first answer", () => {
    expect(contextStatus({ limitTokens: 183_616 })).toBeUndefined()
  })

  // Reproduce: always return the whole text; a narrow terminal wraps the status line.
  test("drops the cache share, then the counts, then itself, where the status line has no room", () => {
    const context = contextStatus(haiku)!
    // "Cloud · Claude Haiku 4.5 · Ask first" takes 36 columns.
    expect(fittedContextText(context, 36, 100)).toBe("ctx 38k/184k · 92% cached")
    expect(fittedContextText(context, 36, 60)).toBe("ctx 38k/184k")
    expect(fittedContextText(context, 36, 50)).toBe("ctx 21%")
    expect(fittedContextText(context, 36, 45)).toBeUndefined()
  })
})

describe("/context", () => {
  // Removal proof: leave the answer's room out of contextBreakdown; the bar no longer spans the
  // model's window, and the room kept for the answer reads 0.
  test("lays the window out as one bar, then each part with its share", () => {
    const breakdown = contextBreakdown(
      {
        windowTokens: 65_536,
        limitTokens: 49_152,
        usedTokens: 43_900,
        parts: [
          { part: "system", tokens: 8_300 },
          { part: "tools", tokens: 5_700 },
          { part: "summary", tokens: 1_700 },
          { part: "messages", tokens: 11_000 },
          { part: "toolResults", tokens: 17_200 },
        ],
        lastCall: { inputTokens: 43_000, cacheReadInputTokens: 40_000 },
        lastCompaction: {
          createdAt: "2026-11-01T09:48:00.000Z",
          estimatedInputTokensBefore: 53_900,
          estimatedInputTokensAfter: 17_200,
        },
      },
      { bar: 50, row: 20 },
      Date.parse("2026-11-01T10:00:00.000Z")
    )!

    expect(breakdown.headline).toBe("44k of 49k tokens")
    expect(breakdown.share).toBe("89%")
    expect(breakdown.warning).toBe("Almost full: earlier messages are condensed soon.")
    // 43,900 used, 5,252 free and 16,384 kept: 33, 4 and 13 of 50 tiles.
    expect(breakdown.bar).toEqual({ used: 33, free: 4, reserved: 13 })
    expect(
      breakdown.rows.map((row) => [row.label, row.tokens, row.share ?? "", row.tiles])
    ).toEqual([
      ["Sixb instructions", "8.3k", "19%", 4],
      ["Tools", "5.7k", "13%", 3],
      ["Earlier summary", "1.7k", "4%", 1],
      ["Messages", "11k", "25%", 5],
      ["Tool results", "17k", "39%", 8],
      ["Free space", "5.3k", "", 0],
      ["Kept for the answer", "16k", "", 0],
    ])
    expect(breakdown.notes).toEqual([
      "Condensed 12m ago · 54k → 17k",
      "93% of the last call read from cache",
    ])
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
