import { describe, expect, test } from "bun:test"
import { lexShellCommand } from "../src/agent/bash/shell"

describe("lexShellCommand", () => {
  test("records output redirects without treating their targets as command arguments", () => {
    expect(lexShellCommand(`echo hello > "report.txt"`)).toEqual([
      {
        command: `echo hello > "report.txt"`,
        tokens: ["echo", "hello"],
        outputRedirects: ["report.txt"],
        operatorBefore: undefined,
      },
    ])
  })

  test("reads a descriptor duplicated onto another as part of its command", () => {
    // Guard proof: drop the duplication branch in lexShellCommand; `&1` then reads as a background
    // job and the whole command turns opaque.
    expect(lexShellCommand(`sixb history search "quote" 2>&1 | head -50`)).toEqual([
      {
        command: `sixb history search "quote" 2>&1`,
        tokens: ["sixb", "history", "search", "quote"],
        operatorBefore: undefined,
      },
      { command: "head -50", tokens: ["head", "-50"], operatorBefore: "|" },
    ])
    expect(lexShellCommand("echo done >&2")?.[0]?.tokens).toEqual(["echo", "done"])
    expect(lexShellCommand("cat notes.md 2>&-")?.[0]?.tokens).toEqual(["cat", "notes.md"])
  })

  test("leaves shell programs and heredocs opaque", () => {
    expect(lexShellCommand("if true; then echo yes; fi")).toBeNull()
    expect(lexShellCommand("cat <<'EOF'\nhello\nEOF")).toBeNull()
    expect(lexShellCommand("echo one & echo two")).toBeNull()
    expect(lexShellCommand("(bun test || true)")).toBeNull()
    expect(lexShellCommand("{ bun test || true; }")).toBeNull()
    expect(lexShellCommand("[[ -f MEMORY.md ]] && cat MEMORY.md")).toBeNull()
  })
})
