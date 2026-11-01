import { describe, expect, test } from "bun:test"
import {
  memoryFileName,
  memoryLineDiff,
  memoryLinkName,
  memoryLinkPath,
} from "../src/pages/settings/memory-files"

describe("memory files on the Memory page", () => {
  test("are named by their paths without .md, and a [[link]] names the file it means", () => {
    expect(memoryFileName("projects/payments.md")).toBe("projects/payments")
    expect(memoryFileName("metrics/keep_rate.sql")).toBe("metrics/keep_rate.sql")
    expect(memoryLinkName("projects/payments.md")).toBe("payments")
    expect(memoryLinkName("metrics/keep_rate.sql")).toBe("keep_rate.sql")
    expect(memoryLinkPath("projects/payments")).toBe("projects/payments.md")
    expect(memoryLinkPath("metrics/keep_rate.sql")).toBe("metrics/keep_rate.sql")
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
