import { describe, expect, test } from "bun:test"
import { coerceReadInput, coerceReadOutput, describeRead } from "../src/read/interpret"

const output = {
  path: "src/runtime.ts",
  content: "one\ntwo",
  startLine: 4,
  endLine: 5,
  truncated: true,
  nextOffset: 6,
}

describe("read tool presentation", () => {
  test("coerces the tool contract and rejects malformed output", () => {
    expect(coerceReadInput({ path: "src/runtime.ts", offset: 4 })).toEqual({
      path: "src/runtime.ts",
    })
    expect(coerceReadOutput(output)).toEqual(output)
    expect(coerceReadOutput({ ...output, startLine: "4" })).toBeNull()
  })

  test("describes ordinary files with their range and continuation state", () => {
    expect(describeRead({ path: output.path }, output)).toEqual({
      path: "src/runtime.ts",
      target: "runtime.ts",
      detail: "lines 4–5 · more available",
      skill: false,
    })
  })

  test("turns skill files into friendly private guide labels", () => {
    expect(describeRead({ path: ".sixb/agent/skills/sixb-actions/SKILL.md" }, null)).toMatchObject({
      target: "the actions guide",
      skill: true,
    })
    expect(
      describeRead({ path: ".sixb/agent/skills/sixb-query/references/query-api.md" }, null)
    ).toMatchObject({ target: "the query api reference", skill: true })
  })

  test("labels empty files without inventing a line range", () => {
    expect(describeRead(null, { ...output, content: "", truncated: false }).detail).toBe("empty")
  })
})
