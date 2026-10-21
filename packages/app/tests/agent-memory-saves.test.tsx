import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { savedMemories } from "../src/agent/bash/interpret"
import { AssistantBody } from "../src/agent/components/message-parts"
import type { NormalizedPart } from "../src/agent/parts"

function bash(command: string, stdout: string, exitCode = 0): NormalizedPart {
  return {
    kind: "tool",
    tool: {
      toolName: "bash",
      state: "output-available",
      input: { command },
      output: { exitCode, stdout, stderr: "", durationMs: 40 },
    },
  }
}

const conflict = bash(
  'sixb memory save user -m "Invoices exclude VAT"',
  '{"repo":"user","saved":false,"conflicts":[{"path":"MEMORY.md","theirs":"MEMORY.md.theirs"}]}',
  1
)
const merged = bash(
  'printf "%s\\n" "- Invoices exclude VAT" >> "$SIXB_MEMORY_DIR/user/MEMORY.md" && sixb memory save user -m "Invoices exclude VAT"',
  '{"repo":"user","saved":true,"revision":5,"changed":["MEMORY.md"]}'
)

describe("what a turn saved to memory", () => {
  test("is each save that stored a revision, by what it says it remembered", () => {
    expect(
      savedMemories([
        conflict,
        merged,
        bash(
          'sixb memory save user -m "Nothing new"',
          '{"repo":"user","saved":false,"changed":[]}'
        ),
        bash("sixb memory pull", '{"repo":"user","revision":5,"updated":[],"conflicts":[]}'),
        // A heredoc edit, then its save on the next line.
        bash(
          `cat >> "$SIXB_MEMORY_DIR/user/MEMORY.md" <<'EOF'\n- Prefers bullets\nEOF\nsixb memory save user -m "Prefers bullets"`,
          '{"repo":"user","saved":true,"revision":6,"changed":["MEMORY.md"]}'
        ),
        // Saved again, under the same words: one line is enough.
        merged,
      ])
    ).toEqual(["Invoices exclude VAT", "Prefers bullets"])
  })

  test("is said below the reply, where the collapsed work would hide it", () => {
    // Reproduce by dropping the SavedToMemory blocks from AssistantBody: the save shows only
    // inside the collapsed work, and the reply says nothing about it.
    const html = renderToStaticMarkup(
      <AssistantBody parts={[conflict, merged, { kind: "text", text: "Noted." }]} />
    )
    expect(html).toContain("Saved to memory")
    expect(html).toContain("· Invoices exclude VAT")
    expect(html.match(/Saved to memory/g)).toHaveLength(1)
  })
})
