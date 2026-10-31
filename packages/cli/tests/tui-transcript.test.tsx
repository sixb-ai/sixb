/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from "bun:test"
import type { SyntaxStyle } from "@opentui/core"
import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { toolLine } from "../src/tui/format"
import { approvalOutcomes, type StoredMessage, shownMessage } from "../src/tui/parts"
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
