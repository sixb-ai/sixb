import { describe, expect, test } from "bun:test"
import { fr } from "../src/agent/i18n/fr"
import { coerceReadInput, coerceReadOutput, describeRead } from "../src/agent/read/interpret"

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
      title: "Read runtime.ts",
      runningTitle: "Reading runtime.ts",
      failedTitle: "Couldn't read runtime.ts",
      detail: "lines 4–5 · more available",
      skill: false,
      memory: false,
    })
    expect(describeRead({ path: output.path }, output, fr)).toMatchObject({
      runningTitle: "Lecture de runtime.ts",
      detail: "lignes 4 à 5 · suite disponible",
    })
    // An empty file has no line range to invent.
    expect(describeRead(null, { ...output, content: "", truncated: false }).detail).toBe("empty")
  })

  test("turns skill files into friendly private guide labels", () => {
    expect(describeRead({ path: ".sixb/agent/skills/sixb-actions/SKILL.md" }, null)).toMatchObject({
      runningTitle: "Reading the actions guide",
      skill: true,
    })
    expect(
      describeRead({ path: ".sixb/agent/skills/sixb-query/references/query-api.md" }, null)
    ).toMatchObject({ title: "Read the query api reference", skill: true })
  })

  test("names a memory file by its path in the memory, not the lines read", () => {
    const path = "/workspace/.sixb/agent/memory/user/projects/payments.md"
    expect(describeRead({ path }, { ...output, path })).toMatchObject({
      title: "Read memory",
      runningTitle: "Reading memory",
      detail: "payments",
      memory: true,
    })
    expect(describeRead({ path: ".sixb/agent/memory/user/MEMORY.md" }, null)).not.toHaveProperty(
      "detail"
    )
    expect(describeRead({ path }, null, fr)).toMatchObject({ title: "Mémoire consultée" })
    expect(describeRead({ path: ".sixb/agent/memory/project/vocabulary.md" }, null)).toMatchObject({
      title: "Read project memory",
      detail: "vocabulary",
    })
  })
})
