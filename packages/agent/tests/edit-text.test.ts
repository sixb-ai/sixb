import { describe, expect, test } from "bun:test"
import { editText } from "../src/tools/edit-text"

const file = ["import { a } from 'a'", "", "export function f() {", "  return a + 1", "}", ""].join(
  "\n"
)

describe("editText", () => {
  test("replaces one exact match and shows it as a diff with its line numbers", () => {
    const result = editText(file, { old: "a + 1", new: "a + 2", all: false })
    expect(result).toEqual({
      ok: true,
      replaced: 1,
      added: 1,
      removed: 1,
      text: file.replace("a + 1", "a + 2"),
      // The final newline ends the last line: no empty line after it.
      diff: [
        "@@ -2,4 +2,4 @@",
        " ",
        " export function f() {",
        "-  return a + 1",
        "+  return a + 2",
        " }",
        "",
      ].join("\n"),
    })
  })

  test("shows whole removed lines once, not the line after them as changed too", () => {
    const result = editText("a\nb\nc\n", { old: "b\n", new: "", all: false })
    expect(result).toMatchObject({ ok: true, text: "a\nc\n" })
    expect(result.ok && result.diff).toBe("@@ -1,3 +1,2 @@\n a\n-b\n c\n")
  })

  // Removal proof: split the text on every newline in unifiedDiff; a file ending in one gets an
  // empty last line, counted in the hunk and shown as context.
  test("counts a file's final newline as the end of its last line", () => {
    const four = "one\ntwo\nthree\nfour\n"
    const changed = editText(four, { old: "four\n", new: "4\n", all: false })
    expect(changed.ok && changed.diff).toBe("@@ -2,3 +2,3 @@\n two\n three\n-four\n+4\n")
    // The final newline removed with the last line: nothing past the last line shows.
    const dropped = editText(four, { old: "\nfour\n", new: "\n", all: false })
    expect(dropped.ok && dropped.diff).toBe("@@ -2,3 +2,2 @@\n two\n three\n-four\n")
  })

  test("refuses an ambiguous match unless asked for all, naming the lines", () => {
    const text = "x = 1\ny = 1\nz = 1\n"
    expect(editText(text, { old: "= 1", new: "= 2", all: false })).toEqual({
      ok: false,
      reason:
        "old_string matches 3 times (lines 1, 2, 3). Add surrounding lines to make it unique, or pass replace_all: true.",
    })
    const all = editText(text, { old: "= 1", new: "= 2", all: true })
    expect(all).toMatchObject({ ok: true, replaced: 3, text: "x = 2\ny = 2\nz = 2\n" })
    // Adjacent changes share one hunk.
    expect(all.ok && all.diff.match(/^@@/gm)).toHaveLength(1)
  })

  test("points at the same text with other whitespace", () => {
    const result = editText(file, {
      old: "export function f() {\n    return a + 1\n}",
      new: "x",
      all: false,
    })
    expect(result).toEqual({
      ok: false,
      reason:
        "old_string matches nothing exactly. The same text with other whitespace is at lines 3-5: copy it as the file has it.",
    })
  })

  test("points at the first line when what follows it differs", () => {
    const result = editText(file, {
      old: "export function f() {\n  return b",
      new: "x",
      all: false,
    })
    expect(result).toEqual({
      ok: false,
      reason:
        "old_string matches nothing. Its first line is at line 3, but what follows differs: read the file there again.",
    })
  })

  test("matches a file that ends its lines with \\r\\n, and keeps them", () => {
    const text = "one\r\ntwo\r\nthree\r\n"
    expect(editText(text, { old: "one\ntwo", new: "1\n2", all: false })).toMatchObject({
      ok: true,
      text: "1\r\n2\r\nthree\r\n",
    })
  })

  test("cuts a long diff after a few thousand characters, saying how many hunks are left", () => {
    const text = Array.from({ length: 400 }, (_, index) => `line ${index} target ${"x".repeat(40)}`)
      .map((line, index) => (index % 10 === 0 ? line : line.replace("target", "keep")))
      .join("\n")
    const result = editText(text, { old: "target", new: "changed", all: true })
    expect(result).toMatchObject({ ok: true, replaced: 40 })
    expect(result.ok && result.diff.length).toBeLessThan(4_100)
    expect(result.ok && result.diff).toMatch(/… \d+ more hunks\n$/)
  })

  // Reproduce: count added and removed from the diff unifiedDiff returns; past the cut, they
  // then fall short of the 40 lines changed.
  test("counts every line it changed, though the diff is cut", () => {
    const text = Array.from({ length: 400 }, (_, index) => `line ${index} target ${"x".repeat(40)}`)
      .map((line, index) => (index % 10 === 0 ? line : line.replace("target", "keep")))
      .join("\n")
    const result = editText(text, { old: "target", new: "changed", all: true })
    expect(result).toMatchObject({ ok: true, added: 40, removed: 40 })

    const shown = result.ok ? result.diff.split("\n").filter((line) => line.startsWith("+")) : []
    expect(shown.length).toBeLessThan(40)
  })

  // Reproduce: push every range in unifiedDiff without merging it into the one before; the line
  // then shows, and counts, once for each match on it.
  test("shows and counts a line two matches changed once", () => {
    const result = editText("x\na a\ny\n", { old: "a", new: "b", all: true })
    expect(result).toEqual({
      ok: true,
      text: "x\nb b\ny\n",
      replaced: 2,
      diff: "@@ -1,3 +1,3 @@\n x\n-a a\n+b b\n y\n",
      added: 1,
      removed: 1,
    })
  })
})
