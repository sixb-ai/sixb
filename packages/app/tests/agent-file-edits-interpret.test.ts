import { describe, expect, test } from "bun:test"
import { describeEdit, describeWrite, parseDiff } from "../src/agent/file-edits/interpret"

describe("file edits in the chat", () => {
  test("a diff reads as its hunks, lines added and removed, context and notes", () => {
    expect(parseDiff("@@ -1,2 +1,2 @@\n a\n-b\n+c\n… 2 more hunks\n")).toEqual([
      { kind: "hunk", text: "@@ -1,2 +1,2 @@" },
      { kind: "context", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "c" },
      { kind: "note", text: "… 2 more hunks" },
    ])
  })

  test("an edit counts what it added and removed; one still streaming names its file", () => {
    // Stored before an edit counted its lines, as an old thread replays it: the diff is counted.
    expect(
      describeEdit({
        input: { path: "a/b.ts" },
        output: { path: "a/b.ts", replaced: 1, diff: "@@ -1 +1,2 @@\n-x\n+y\n+z\n" },
      })
    ).toMatchObject({ title: "Edited b.ts", detail: "+2 −1", added: 2, removed: 1 })
    expect(describeEdit({ input: { path: "a/b.ts" }, output: undefined })).toMatchObject({
      runningTitle: "Editing b.ts",
      lines: [],
    })
  })

  // Reproduce: count added and removed from the diff alone in describeEdit; the cut diff then
  // shows +1 −1.
  test("an edit whose diff was cut counts all its changed lines", () => {
    expect(
      describeEdit({
        input: { path: "a/b.ts" },
        output: {
          path: "a/b.ts",
          replaced: 40,
          diff: "@@ -1 +1 @@\n-x\n+y\n… 39 more hunks\n",
          added: 40,
          removed: 40,
        },
      })
    ).toMatchObject({ detail: "+40 −40", added: 40, removed: 40 })
  })

  test("a write shows what it wrote as added lines", () => {
    expect(
      describeWrite({
        input: { path: "x.md", content: "one\ntwo\n" },
        output: { path: "x.md", created: true, lines: 2, bytes: 8 },
      })
    ).toMatchObject({
      title: "Created x.md",
      detail: "2 lines",
      lines: [
        { kind: "added", text: "one" },
        { kind: "added", text: "two" },
      ],
    })
  })
})
