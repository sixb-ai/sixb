/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from "bun:test"
import { RGBA, SyntaxStyle } from "@opentui/core"
import type { TestRendererSetup } from "@opentui/core/testing"
import { useRenderer } from "@opentui/react"
import { testRender } from "@opentui/react/test-utils"
import { useMemo, useState } from "react"
import { toolLine } from "../src/tui/format"
import {
  approvalOutcomes,
  type LiveRun,
  liveRun,
  type StoredMessage,
  shownMessage,
} from "../src/tui/parts"
import { tuiColors } from "../src/tui/theme"
import { Transcript } from "../src/tui/transcript"

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
        computerRuns={false}
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
      computerRuns={false}
      width={90}
      approvalChoice={0}
    />
  )
}

/** The screen's rows once `turn` is drawn, after highlighting that is ready has landed. */
async function draw(screen: TestRendererSetup, turn: Turn): Promise<string[]> {
  showTurn(turn)
  await screen.renderOnce()
  await new Promise((resolve) => setImmediate(resolve))
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
