import { describe, expect, test } from "bun:test"
import { lexShellCommand } from "../src/bash/shell"

describe("lexShellCommand", () => {
  test("returns quote-normalized tokens without changing the displayed command", () => {
    expect(
      lexShellCommand(`sixb objects get RepositoryIssue 'github:issue:sixb-ai/sixb#297'`)
    ).toEqual([
      {
        command: `sixb objects get RepositoryIssue 'github:issue:sixb-ai/sixb#297'`,
        tokens: ["sixb", "objects", "get", "RepositoryIssue", "github:issue:sixb-ai/sixb#297"],
        operatorBefore: undefined,
      },
    ])
  })

  test("splits top-level compound operators and preserves branch relationships", () => {
    expect(lexShellCommand("cd packages && sixb ontology list | jq .")).toEqual([
      { command: "cd packages", tokens: ["cd", "packages"], operatorBefore: undefined },
      {
        command: "sixb ontology list",
        tokens: ["sixb", "ontology", "list"],
        operatorBefore: "&&",
      },
      { command: "jq .", tokens: ["jq", "."], operatorBefore: "|" },
    ])
  })

  test("does not split quoted operators", () => {
    expect(lexShellCommand(`printf '%s' 'one && two'`)).toEqual([
      {
        command: `printf '%s' 'one && two'`,
        tokens: ["printf", "%s", "one && two"],
        operatorBefore: undefined,
      },
    ])
  })

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
