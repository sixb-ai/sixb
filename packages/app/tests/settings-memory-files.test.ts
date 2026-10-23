import { describe, expect, test } from "bun:test"
import {
  linkMemoryFiles,
  memoryFileHref,
  memoryFileName,
  memoryLineDiff,
  memoryLinkName,
  memoryTree,
} from "../src/pages/settings/memory-files"

describe("memory files on the Memory page", () => {
  test("are named by their paths without .md, and laid out as a tree", () => {
    expect(memoryFileName("projects/payments.md")).toBe("projects/payments")
    expect(memoryFileName("metrics/keep_rate.sql")).toBe("metrics/keep_rate.sql")
    expect(memoryLinkName("projects/payments.md")).toBe("payments")
    expect(memoryLinkName("metrics/keep_rate.sql")).toBe("keep_rate.sql")
    expect(
      memoryTree([
        "metrics/keep_rate.sql",
        "projects/payments.md",
        "projects/q4/close.md",
        "team.md",
      ]).map(
        (row) => `${"  ".repeat(row.depth)}${row.kind === "folder" ? `${row.name}/` : row.name}`
      )
    ).toEqual([
      "metrics/",
      "  keep_rate.sql",
      "projects/",
      "  payments",
      "  q4/",
      "    close",
      "team",
    ])
  })

  test("link [[links]] to files the repo holds, and name the rest", () => {
    const linked = linkMemoryFiles(
      "See [[projects/payments]], [[metrics/keep_rate.sql]] and [[gone]].",
      new Set(["projects/payments.md", "metrics/keep_rate.sql"]),
      (path) => memoryFileHref("project", path),
      memoryLinkName
    )
    expect(linked).toBe(
      "See [payments](?repo=project&file=projects%2Fpayments.md), [keep_rate.sql](?repo=project&file=metrics%2Fkeep_rate.sql) and gone."
    )
  })

  test("diff a change line by line, a replaced line read as removed, then added", () => {
    expect(
      memoryLineDiff(
        "# Memory\n\n- Excluding VAT\n- Bullets\n",
        "# Memory\n\n- Including VAT\n- Bullets\n- Lyon office\n"
      )
    ).toEqual([
      { kind: "same", text: "# Memory" },
      { kind: "same", text: "" },
      { kind: "removed", text: "- Excluding VAT" },
      { kind: "added", text: "- Including VAT" },
      { kind: "same", text: "- Bullets" },
      { kind: "added", text: "- Lyon office" },
    ])
    expect(memoryLineDiff("", "- New\n")).toEqual([{ kind: "added", text: "- New" }])
    expect(memoryLineDiff("- Gone\n", "")).toEqual([{ kind: "removed", text: "- Gone" }])
  })
})
