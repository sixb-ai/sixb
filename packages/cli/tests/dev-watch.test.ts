import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { isSource } from "../src/lib/dev-watch"

// Reproduce: drop the agent context check from `isSource` and the Agent's files stop restarting
// `sixb dev`, so a fixed SKILL.md never reloads a dev child that crashed on it.
describe("dev source watching", () => {
  test("restarts on the files the Agent reads", () => {
    for (const path of [
      "SIXB.md",
      join("skills", "acme-style", "SKILL.md"),
      join("skills", "acme-style", "scripts", "extract.py"),
      join("ontology", "billing", "invoice.md"),
      join("ontology", "billing", "scripts", "export.py"),
      join("ontology", "scripts", "lib", "util.sh"),
    ]) {
      expect(isSource(path)).toBe(true)
    }
  })

  test("ignores other non-code files", () => {
    for (const path of [
      "README.md",
      join("docs", "SIXB.md"),
      join("public", "logo.png"),
      join("ontology", "billing", "notes.txt"),
    ]) {
      expect(isSource(path)).toBe(false)
    }
  })
})
