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

  test("leaves shell programs and heredocs opaque", () => {
    expect(lexShellCommand("if true; then echo yes; fi")).toBeNull()
    expect(lexShellCommand("cat <<'EOF'\nhello\nEOF")).toBeNull()
    expect(lexShellCommand("echo one & echo two")).toBeNull()
    expect(lexShellCommand("(bun test || true)")).toBeNull()
    expect(lexShellCommand("{ bun test || true; }")).toBeNull()
  })
})
