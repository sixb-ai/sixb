import { describe, expect, test } from "bun:test"
import {
  insertMemoryEntry,
  memoryBlocks,
  memoryEntries,
  removeMemoryEntry,
  replaceMemoryEntry,
} from "../src/pages/settings/memory-entries"

const note = `# Memory

- Prefers short bullet lists (added 2026-10-04)
- Works on the Lyon office's accounts

## Index
- [[projects/payments]]: billing projects (added 2026-10-12)
`

describe("a note's memories", () => {
  test("are its top-level bullets, each with the day it was added when it says", () => {
    expect(memoryEntries(note)).toEqual([
      { line: 2, text: "Prefers short bullet lists", added: "2026-10-04" },
      { line: 3, text: "Works on the Lyon office's accounts" },
      { line: 6, text: "[[projects/payments]]: billing projects", added: "2026-10-12" },
    ])
    // The opening title is the page's to show; later headings stay between the entries.
    expect(memoryBlocks(note).map((block) => block.kind)).toEqual([
      "entry",
      "entry",
      "heading",
      "entry",
    ])
  })

  test("change one line at a time, keeping every other line and the day it was added", () => {
    const [first, second] = memoryEntries(note)
    if (!first || !second) throw new Error("expected entries")

    expect(replaceMemoryEntry(note, first, "Prefers numbered lists")).toBe(
      note.replace(
        "- Prefers short bullet lists (added 2026-10-04)",
        "- Prefers numbered lists (added 2026-10-04)"
      )
    )
    expect(removeMemoryEntry(note, second)).toBe(
      note.replace("- Works on the Lyon office's accounts\n", "")
    )
  })

  test("take a new one at the end of its section, dated today, as one line", () => {
    // After the section's last entry, so it lands in the list it belongs to.
    expect(insertMemoryEntry(note, 3, "Prefers euros", "2026-10-21")).toBe(
      note.replace(
        "- Works on the Lyon office's accounts\n",
        "- Works on the Lyon office's accounts\n- Prefers euros (added 2026-10-21)\n"
      )
    )
    // A section with no entry yet takes it under its heading; a line break in it is a space.
    expect(insertMemoryEntry("# Memory\n\n## Index\n", 2, "Prefers\neuros", "2026-10-21")).toBe(
      "# Memory\n\n## Index\n- Prefers euros (added 2026-10-21)\n"
    )
  })
})
