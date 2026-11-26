/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from "bun:test"
import { CodeRenderable, type Renderable, RGBA, SyntaxStyle } from "@opentui/core"
import type { TestRendererSetup } from "@opentui/core/testing"
import { useRenderer } from "@opentui/react"
import { testRender } from "@opentui/react/test-utils"
import { useMemo, useState } from "react"
import { toolLine } from "../src/tui/format"
import { type PlaceNames, placeNames } from "../src/tui/moves"
import {
  approvalOutcomes,
  type LiveRun,
  liveRun,
  type StoredMessage,
  shownMessage,
} from "../src/tui/parts"
import { computerName, computerNameInText } from "../src/tui/settings"
import { tuiColors } from "../src/tui/theme"
import { type Run, Transcript } from "../src/tui/transcript"

// A call `sixb` held for approval, then decided: the turn resumes from a message that says how the
// call ended, and the call's own line says it from then on.

const HELD = '{"status":"awaiting_approval","approval":{"id":"apr_1","kind":"action"}}'

function heldReply(): StoredMessage {
  return {
    id: "m1",
    threadId: "t",
    projectId: "p",
    seq: 2,
    runId: "agt_run_1",
    role: "assistant",
    createdAt: "2026-10-30T00:00:00.000Z",
    contentVersion: 1,
    parts: [
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "bash",
        state: "output-available",
        input: { command: "sixb actions request add-field-note --file -" },
        output: { exitCode: 4, stdout: HELD },
      },
    ],
  } as unknown as StoredMessage
}

function resumed(status: string, outcome?: Record<string, unknown>): StoredMessage {
  return {
    id: "m2",
    threadId: "t",
    projectId: "p",
    seq: 3,
    runId: "agt_run_2",
    role: "user",
    createdAt: "2026-10-30T00:01:00.000Z",
    contentVersion: 1,
    parts: [
      {
        type: "approval-outcome",
        approvalId: "apr_1",
        status,
        call: { kind: "action", actionId: "add-field-note", subject: { kind: "none" } },
        ...(outcome ? { outcome } : {}),
      },
    ],
  } as unknown as StoredMessage
}

function shown(...messages: StoredMessage[]) {
  return messages.flatMap((message) => shownMessage(message) ?? [])
}

/** The names a person's own conversation is written with, on this computer. */
const NAMES = placeNames({ thread: null, computerId: "cmp_1", mine: true })

let setup: TestRendererSetup | null = null
afterEach(() => {
  setup?.renderer.destroy()
  setup = null
})

describe("a held call", () => {
  // Guard proof: in shownMessage (src/tui/parts.ts), leave `outcomes` empty, as when the
  // `approval-outcome` parts fell to `default: return []`: every case reads "held for your approval".
  test("reads as decided once a later message says how it ended", () => {
    const callLine = (...messages: StoredMessage[]) => {
      const view = shown(...messages)
      const call = view[0]?.parts[0]
      if (call?.kind !== "tool") throw new Error("Expected the held call.")
      return toolLine(call, approvalOutcomes(view))
    }
    const ran = (status: string) => ({ kind: "action-run", runId: "agt_action_run_1", status })

    // Still waiting: nothing said how it ended.
    expect(callLine(heldReply())).toMatchObject({ held: true, note: "held for your approval" })

    const approved = callLine(heldReply(), resumed("approved", ran("succeeded")))
    expect(approved).toMatchObject({ note: "approved" })
    expect(approved.held).toBeUndefined()
    expect(approved.failed).toBeUndefined()

    expect(callLine(heldReply(), resumed("denied"))).toMatchObject({ note: "denied" })
    expect(callLine(heldReply(), resumed("approved", ran("failed")))).toMatchObject({
      note: "approved, but it failed",
      failed: true,
    })
  })

  // Guard proof: in Transcript (src/tui/transcript.tsx), render `messages` instead of `shown`, or
  // call toolLine without `outcomes`: the trigger draws an empty box, or the call reads as held.
  test("shows how it ended in the transcript, and nothing of the message that said so", async () => {
    setup = await testRender(
      <Transcript
        colors={tuiColors("dark")}
        // Only an answer's text uses it, and these messages have none.
        syntax={{} as SyntaxStyle}
        messages={shown(heldReply(), resumed("approved"))}
        runs={[]}
        live={null}
        approvals={[]}
        modelNames={new Map()}
        thread={null}
        names={NAMES}
        width={100}
        approvalChoice={0}
      />,
      { width: 100, height: 20 }
    )
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false })
    await setup.renderOnce()
    const frame = setup.captureCharFrame()

    expect(frame).toContain("$ sixb actions request add-field-note --file -")
    expect(frame).toContain("approved")
    expect(frame).not.toContain("held for your approval")
    // A person's message is drawn with a heavy left border.
    expect(frame).not.toContain("┃")
  })
})

describe("a search's results", () => {
  // Guard proof: in shownLine (src/tui/transcript.tsx), drop the `paths` branch; the row then
  // shows the sandbox's folder in full.
  test("show their paths as the person reads them", async () => {
    const run = "/private/var/folders/x1/T/sixb-agent/thr_1/.sixb/agent"
    const message = {
      ...heldReply(),
      parts: [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "grep",
          state: "output-available",
          input: { pattern: "invoice", path: `${run}/memory/user` },
          output: {
            matches: [
              {
                path: `${run}/memory/user/billing.md`,
                line: 3,
                text: "Invoices go out on the 1st",
              },
            ],
            files: 1,
            truncated: false,
          },
        },
      ],
    } as unknown as StoredMessage
    setup = await testRender(
      <Transcript
        colors={tuiColors("dark")}
        // Only an answer's text uses it, and this message has none.
        syntax={{} as SyntaxStyle}
        messages={shown(message)}
        runs={[]}
        live={null}
        approvals={[]}
        modelNames={new Map()}
        thread={null}
        names={NAMES}
        width={100}
        approvalChoice={0}
      />,
      { width: 100, height: 10 }
    )
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false })
    await setup.renderOnce()
    const frame = setup.captureCharFrame()

    expect(frame).toContain('grep  "invoice" in run/memory/user  1 match in 1 file')
    expect(frame).toContain("run/memory/user/billing.md:3 Invoices go out on the 1st")
    expect(frame).not.toContain("sixb-agent")
  })
})

// After a move, each turn still says where it ran, and a line marks every move between two turns,
// as the app's transcript does.
describe("a conversation that moved", () => {
  const message = (id: string, role: "user" | "assistant", minute: number, runId?: string) =>
    ({
      id,
      threadId: "t",
      projectId: "p",
      seq: minute,
      runId: runId ?? null,
      role,
      createdAt: `2026-11-16T10:0${minute}:00.000Z`,
      contentVersion: 1,
      parts: role === "user" ? [{ type: "text", text: `Message ${minute}` }] : [],
    }) as unknown as StoredMessage

  const run = (id: string, trigger: string, place?: { id: string; folder: string }): Run =>
    ({
      id,
      projectId: "p",
      kind: "conversation",
      threadId: "t",
      triggerMessageId: trigger,
      status: "succeeded",
      createdAt: "2026-11-16T10:00:00.000Z",
      ...(place ? { runsOn: "computer" as const, computer: place } : {}),
    }) as unknown as Run

  /** The turns' meta lines and move lines, as the transcript draws them. */
  const placeRows = async (input: {
    readonly messages: readonly StoredMessage[]
    readonly runs: readonly Run[]
    readonly thread: Parameters<typeof Transcript>[0]["thread"]
    readonly names: PlaceNames
    /** The person's messages too, to show where a line falls between them. */
    readonly withMessages?: boolean
  }) => {
    setup = await testRender(
      <Transcript
        colors={tuiColors("dark")}
        // Only an answer's text uses it, and these answers have none.
        syntax={{} as SyntaxStyle}
        messages={shown(...input.messages)}
        runs={input.runs}
        live={null}
        approvals={[]}
        modelNames={new Map()}
        thread={input.thread}
        names={input.names}
        width={100}
        approvalChoice={0}
      />,
      { width: 100, height: 40 }
    )
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false })
    await setup.renderOnce()

    return setup
      .captureCharFrame()
      .split("\n")
      .map((row) => row.trim())
      .filter(
        (row) =>
          row.startsWith("▰") ||
          row.startsWith("◇") ||
          (input.withMessages === true && row.startsWith("┃  Message"))
      )
  }

  // Guard proof: in RunMeta (src/tui/transcript.tsx), name the place from the thread's current
  // runsOn again, or leave `transcriptMoves` out: every turn reads Cloud, and no move is marked.
  test("names each turn's own place, and marks each move", async () => {
    const rows = await placeRows({
      messages: [
        message("u1", "user", 1),
        message("a1", "assistant", 2, "r1"),
        message("u2", "user", 3),
        message("a2", "assistant", 4, "r2"),
        message("u3", "user", 5),
        message("a3", "assistant", 6, "r3"),
      ],
      runs: [
        run("r1", "u1"),
        run("r2", "u2", { id: "cmp_1", folder: "/Users/ada/code/sixb" }),
        run("r3", "u3", { id: "cmp_1", folder: "/Users/ada/code/docs" }),
      ],
      // Back in the cloud since, with no turn there yet.
      thread: { createdAt: "2026-11-16T10:00:00.000Z", movedAt: "2026-11-16T10:07:00.000Z" },
      names: NAMES,
    })

    expect(rows).toEqual([
      "▰ Cloud",
      `◇ Moved to sixb on ${computerNameInText()}. The cloud's files stay behind.`,
      `▰ ${computerName()} · sixb`,
      "◇ Moved from sixb to docs. The files in sixb stay behind.",
      `▰ ${computerName()} · docs`,
      "◇ Moved to the cloud. The files in docs stay behind.",
    ])
  })

  // Guard proof: in transcriptMoves (src/tui/moves.ts), drop `!samePlace(previous, current)` from
  // the latest move, or keep a retried turn's first run: the conversation reads as moved.
  test("marks no move for a round trip with no turn in between", async () => {
    const rows = await placeRows({
      messages: [message("u1", "user", 1), message("a1", "assistant", 2, "r1")],
      // Retried in the cloud after a first try on the computer: the latest run is where it went.
      runs: [run("r0", "u1", { id: "cmp_1", folder: "/Users/ada/code/sixb" }), run("r1", "u1")],
      // Moved to a folder and back to the cloud since.
      thread: { createdAt: "2026-11-16T10:00:00.000Z", movedAt: "2026-11-16T10:05:00.000Z" },
      names: NAMES,
    })

    expect(rows).toEqual(["▰ Cloud"])
  })

  // Guard proof: in transcriptMoves (src/tui/moves.ts), leave `forked` false: the fork's first
  // turn, and a fork no turn ran in yet, show no line where they continue.
  test("marks where a fork continues, after the copies it began with", async () => {
    // Copied from the conversation it was forked from: written before the fork was.
    const copies = [message("u1", "user", 1), message("a1", "assistant", 2, "r_source")]

    const firstTurn = await placeRows({
      messages: [...copies, message("u2", "user", 4), message("a2", "assistant", 5, "r2")],
      runs: [run("r2", "u2", { id: "cmp_1", folder: "/Users/ada/code/sixb" })],
      thread: {
        createdAt: "2026-11-16T10:03:00.000Z",
        runsOn: "computer",
        computer: { id: "cmp_1", name: "Studio", folder: "/Users/ada/code/sixb", online: true },
      },
      names: NAMES,
    })
    expect(firstTurn).toEqual([
      `◇ Continued in sixb on ${computerNameInText()}. The original conversation's files stay with it.`,
      `▰ ${computerName()} · sixb`,
    ])

    setup?.renderer.destroy()
    const noTurnYet = await placeRows({
      messages: copies,
      runs: [],
      thread: { createdAt: "2026-11-16T10:03:00.000Z" },
      names: NAMES,
    })
    expect(noTurnYet).toEqual([
      "◇ Continued in the cloud. The original conversation's files stay with it.",
    ])
  })

  // Guard proof: in transcriptMoves (src/tui/moves.ts), place a fork's line before its first turn
  // after the last message dated by `movedAt` again: it falls between the copies, or nowhere.
  test("places a fork's line after its last copy, whenever its source moved", async () => {
    // Four copies of a source conversation, which keeps its `movedAt`.
    const copies = [
      message("u1", "user", 1),
      message("a1", "assistant", 2, "r_source_1"),
      message("u2", "user", 3),
      message("a2", "assistant", 4, "r_source_2"),
    ]
    const forkOf = (movedAt: string) =>
      placeRows({
        messages: copies,
        runs: [],
        thread: { createdAt: "2026-11-16T10:05:00.000Z", movedAt },
        names: NAMES,
        withMessages: true,
      })
    const afterTheCopies = [
      "┃  Message 1",
      "┃  Message 3",
      "◇ Continued in the cloud. The original conversation's files stay with it.",
    ]

    // The source moved between two of the copies.
    expect(await forkOf("2026-11-16T10:02:30.000Z")).toEqual(afterTheCopies)
    setup?.renderer.destroy()

    // The source moved before its first message.
    expect(await forkOf("2026-11-16T10:00:30.000Z")).toEqual(afterTheCopies)
  })

  // Guard proof: in placeNames (src/tui/moves.ts), leave `ownerName` null: the participant reads
  // "the computer" and "Computer", not whose it is.
  test("names the owner's computer to someone they shared it with", async () => {
    const thread = {
      createdAt: "2026-11-16T10:00:00.000Z",
      runsOn: "computer" as const,
      ownerPrincipal: { type: "user" as const, id: "usr_ada" },
      owner: { type: "user" as const, id: "usr_ada", displayName: "Ada" },
    }
    const rows = await placeRows({
      messages: [
        message("u1", "user", 1),
        message("a1", "assistant", 2, "r1"),
        message("u2", "user", 3),
        message("a2", "assistant", 4, "r2"),
      ],
      // The runs keep the computer from them: its folders are the owner's to see.
      runs: [run("r1", "u1"), { ...run("r2", "u2"), runsOn: "computer" }],
      thread,
      names: placeNames({ thread, computerId: "cmp_1", mine: false }),
    })

    expect(rows).toEqual([
      "▰ Cloud",
      "◇ Moved to Ada's computer. The cloud's files stay behind.",
      "▰ Ada's computer",
    ])

    // A fork of it, no turn run yet: on the owner's computer too.
    setup?.renderer.destroy()
    const fork = await placeRows({
      messages: [message("u1", "user", 1)],
      runs: [],
      thread: { ...thread, createdAt: "2026-11-16T10:05:00.000Z" },
      names: placeNames({ thread, computerId: "cmp_1", mine: false }),
    })
    expect(fork).toEqual([
      "◇ Continued on Ada's computer. The original conversation's files stay with it.",
    ])
  })
})

// An answer that streams in: each block's markdown, an emphasis, a link and a code span cut off
// mid-way, a table and a code block.
const ANSWER = `## Your latest emails

Here is a **summary** of the most recent threads, with \`inline code\` too:

- **Acme renewal**: they want a 12% discount by Friday.
- *Hiring*: two candidates on Tuesday.

See [the docs](https://sixb.ai/docs) for **bold with *nested* italic** text.

1. Reply to Acme
2. Read the postmortem

| Thread | From | When |
| --- | --- | --- |
| Acme renewal | Dana | 09:12 |
| Outage | Ops | 09:40 |

\`\`\`ts
const total = threads.reduce((sum, t) => sum + t.count, 0)
\`\`\`

That's everything from today.`

interface Turn {
  readonly text: string
  readonly working: boolean
  /** Its answer is stored: the stored message replaces the streamed one. */
  readonly stored: boolean
}

let showTurn: (turn: Turn) => void = () => {}

/** A turn's answer, streamed then stored, drawn with real markdown highlighting. */
function StreamedTurn() {
  const renderer = useRenderer()
  const colors = tuiColors("dark")
  const syntax = useMemo(
    () =>
      SyntaxStyle.fromStyles(
        { default: { fg: RGBA.fromHex(colors.text) } },
        renderer.nativeScene as Parameters<typeof SyntaxStyle.fromStyles>[1]
      ),
    [renderer, colors.text]
  )
  const [turn, setTurn] = useState<Turn>({ text: "", working: true, stored: false })
  showTurn = setTurn
  const live: LiveRun = {
    ...liveRun("agt_run_1"),
    parts: [{ kind: "text", text: turn.text }],
    working: turn.working,
    finalized: turn.stored,
  }
  const stored = shownMessage({
    id: "m1",
    threadId: "t",
    projectId: "p",
    seq: 2,
    runId: "agt_run_1",
    role: "assistant",
    createdAt: "2026-10-30T00:00:00.000Z",
    contentVersion: 1,
    parts: [{ type: "text", text: turn.text }],
  } as unknown as StoredMessage)
  return (
    <Transcript
      colors={colors}
      syntax={syntax}
      messages={turn.stored && stored ? [stored] : []}
      runs={[]}
      live={live}
      approvals={[]}
      modelNames={new Map()}
      thread={null}
      names={NAMES}
      width={90}
      approvalChoice={0}
    />
  )
}

async function highlighted(node: Renderable): Promise<void> {
  if (node instanceof CodeRenderable) await node.highlightingDone
  for (const child of node.getChildren()) await highlighted(child)
}

/**
 * The screen's rows once `turn` is drawn and highlighted. A block keeps its last text until its
 * highlighting lands, on a worker that takes as long as it takes.
 *
 * Guard proof: wait a `setImmediate` here instead, and delay `TreeSitterClient.highlightOnce` by
 * 20ms from a preload, and the finished answer's lists are drawn cut short.
 */
async function draw(screen: TestRendererSetup, turn: Turn): Promise<string[]> {
  showTurn(turn)
  await screen.renderOnce()
  await highlighted(screen.renderer.root)
  await screen.renderOnce()
  return rowsOf(screen)
}

function rowsOf(screen: TestRendererSetup): string[] {
  return screen
    .captureCharFrame()
    .split("\n")
    .map((row) => row.trimEnd())
}

describe("a streamed answer", () => {
  // Guard proof, each alone in Answer (src/tui/transcript.tsx): drop `internalBlockMode`, and the
  // heading is drawn as "## Your latest emails", then "Your latest emails"; pass `text.trim()`
  // while streaming instead of steadyMarkdown, and "**summary" loses its stars; pass `streaming`
  // alone as the markdown's, and the stored answer is blank until it is highlighted; drop
  // `renderNode`, and so is its code block.
  test("only ever grows on screen, and stays as it is once stored", async () => {
    setup = await testRender(<StreamedTurn />, { width: 90, height: 60 })
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false })
    const moved: string[] = []

    let shown: string[] = []
    // Chunks of 1 to 9 characters, the same on every run.
    let seed = 7
    for (let at = 0; at < ANSWER.length; ) {
      seed = (seed * 48_271) % 2_147_483_647
      at = Math.min(ANSWER.length, at + 1 + (seed % 9))
      const rows = await draw(setup, { text: ANSWER.slice(0, at), working: true, stored: false })
      // A row may grow, or move down as rows are added above it; what it shows never changes.
      for (const [index, was] of shown.entries()) {
        const row = rows[index] ?? ""
        if (was.trim() && !row.startsWith(was) && !rows.includes(was)) {
          moved.push(`${was.trim()} -> ${row.trim()}`)
        }
      }
      shown = rows
    }
    expect(moved).toEqual([])

    const ended = await draw(setup, { text: ANSWER, working: false, stored: false })
    // The first frame of the stored answer, before any highlighting of it could land.
    showTurn({ text: ANSWER, working: false, stored: true })
    await setup.renderOnce()
    const stored = rowsOf(setup)
    expect(stored).toEqual(ended)
    expect(stored.join("\n")).toContain("That's everything from today.")
    expect(stored.join("\n")).toContain("const total = threads.reduce")
  })
})
