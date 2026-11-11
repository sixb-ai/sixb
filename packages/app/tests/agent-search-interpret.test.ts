import { describe, expect, test } from "bun:test"
import { latestWorkLabel } from "../src/agent/activity-label"
import { fr } from "../src/agent/i18n/fr"
import {
  coerceGlobOutput,
  coerceGrepOutput,
  describeGlob,
  describeGrep,
  highlightLine,
  splitPath,
} from "../src/agent/search/interpret"

const grepOutput = {
  pattern: "retries",
  path: "src",
  matches: [
    { path: "src/config.ts", line: 12, text: "const retries = 3" },
    { path: "src/config.ts", line: 40, text: "  retries: 3," },
    { path: "src/queue/worker.ts", line: 7, text: "if (attempt > Retries) fail()" },
  ],
  files: 2,
  more: { "src/config.ts": 5 },
  truncated: false,
}

describe("a search for files by name", () => {
  test("coerces the tool's output and rejects anything else", () => {
    expect(
      coerceGlobOutput({ pattern: "*.md", path: ".", files: ["a.md"], truncated: false })
    ).toEqual({ files: ["a.md"], truncated: false, incomplete: false })
    expect(coerceGlobOutput({ files: ["a.md", 3], truncated: false })).toBeNull()
    expect(coerceGlobOutput({ files: ["a.md"] })).toBeNull()
  })

  test("says what it found, and nothing technical on the line", () => {
    const glob = (output: unknown) =>
      describeGlob({ input: { pattern: "**/*.md", path: "docs" }, output })

    expect(glob({ files: ["docs/a.md", "docs/b.md"], truncated: false })).toMatchObject({
      title: "Found 2 files",
      runningTitle: "Looking for files",
      failedTitle: "Couldn't look for files",
      pattern: "**/*.md",
      path: "docs",
      notes: [],
    })
    expect(glob({ files: [], truncated: false }).title).toBe("No files found")
    expect(glob({ files: ["docs/a.md"], truncated: true, incomplete: true })).toMatchObject({
      title: "Found 1+ files",
      notes: [
        "Only the first 1 files are listed.",
        "The search stopped before it looked everywhere, so some results may be missing.",
      ],
    })
    expect(glob(undefined).title).toBe("Looked for files")
    expect(
      describeGlob({ input: { pattern: "*.md" }, output: { files: [], truncated: false } }, fr)
    ).toMatchObject({ title: "Aucun fichier trouvé", runningTitle: "Recherche de fichiers" })
  })

  test("leaves out the working folder, however the model named it", () => {
    for (const path of [".", "./", "null", "undefined", ""]) {
      expect(describeGlob({ input: { pattern: "*.md", path } })).not.toHaveProperty("path")
    }
  })
})

describe("a search for text", () => {
  test("coerces the tool's output and rejects anything else", () => {
    expect(coerceGrepOutput(grepOutput)).toEqual({
      matches: grepOutput.matches,
      files: 2,
      more: { "src/config.ts": 5 },
      truncated: false,
      incomplete: false,
    })
    expect(
      coerceGrepOutput({ ...grepOutput, matches: [{ path: "a", line: "1", text: "" }] })
    ).toBeNull()
    expect(coerceGrepOutput({ ...grepOutput, files: "2" })).toBeNull()
  })

  test("names the words it looked for, and counts every match, the ones past a file's too", () => {
    expect(
      describeGrep({ input: { pattern: "retries", path: "src" }, output: grepOutput })
    ).toMatchObject({
      title: "Searched for “retries”",
      runningTitle: "Searching files",
      detail: "8 matches in 2 files",
      groups: [
        {
          path: "config.ts",
          matches: [
            { line: 12, text: "const retries = 3" },
            { line: 40, text: "  retries: 3," },
          ],
          more: 5,
        },
        {
          path: "queue/worker.ts",
          matches: [{ line: 7, text: "if (attempt > Retries) fail()" }],
          more: 0,
        },
      ],
    })
    expect(describeGrep({ input: { pattern: "retries" }, output: grepOutput }, fr)).toMatchObject({
      title: "Recherche de « retries »",
      detail: "8 occurrences dans 2 fichiers",
    })
  })

  // Guard proof: in describeGrep, title the step with `call.pattern` in place of `term`; the title
  // then reads `Searched for “retries\s*=”`.
  test("keeps a regular expression off the line, and reads escaped punctuation as words", () => {
    const title = (pattern: string, literal?: boolean) =>
      describeGrep({ input: { pattern, literal }, output: grepOutput }).title

    expect(title("retries\\s*=")).toBe("Searched files")
    expect(title("(foo|bar)")).toBe("Searched files")
    expect(title("retries\\s*=", true)).toBe("Searched for “retries\\s*=”")
    expect(title("invoice\\.total")).toBe("Searched for “invoice.total”")
    expect(title("invoice.total")).toBe("Searched for “invoice.total”")
    expect(title("a".repeat(60))).toBe(`Searched for “${"a".repeat(39)}…”`)
  })

  test("words nothing found and a failure kindly", () => {
    const empty = describeGrep({
      input: { pattern: "retries" },
      output: { matches: [], files: 0, truncated: false },
    })
    expect(empty).toMatchObject({
      title: "Searched for “retries”",
      detail: "no matches",
      groups: [],
    })
    expect(describeGrep({ input: { pattern: "retries" } }).failedTitle).toBe(
      "Couldn't search for “retries”"
    )
    expect(describeGrep({ input: { pattern: "a+" } }).failedTitle).toBe("Couldn't search files")
  })

  test("says when more matched than it shows", () => {
    expect(
      describeGrep({
        input: { pattern: "todo" },
        output: { ...grepOutput, truncated: true, incomplete: true },
      })
    ).toMatchObject({
      detail: "8+ matches",
      notes: [
        "Only the first 3 matching lines are shown. More files match.",
        "The search stopped before it looked everywhere, so some results may be missing.",
      ],
    })
  })
})

describe("a search where the Agent keeps its own files", () => {
  test("reads as its memory, its guides or its ontology, as a read of their files does", () => {
    const grep = (path: string) =>
      describeGrep({ input: { pattern: "invoice", path }, output: grepOutput })

    expect(grep("/workspace/.sixb/agent/memory/user")).toMatchObject({
      place: { kind: "memory", project: false },
      title: "Searched memory",
      runningTitle: "Searching memory",
      detail: "“invoice” · 8 matches in 2 files",
    })
    expect(grep(".sixb/agent/memory/project/notes").title).toBe("Searched project memory")
    expect(grep(".sixb/agent/skills").title).toBe("Searched the guides")
    expect(grep(".sixb/agent/skills/sixb-actions/references").title).toBe(
      "Searched the actions guide"
    )
    expect(grep("/tmp/sixb-agent/t1/.sixb/agent/ontology").title).toBe("Searched the ontology")
    expect(grep("src/memory").title).toBe("Searched for “invoice”")

    expect(
      describeGlob({
        input: { pattern: "*.md", path: ".sixb/agent/memory/user" },
        output: { files: [], truncated: false },
      })
    ).toMatchObject({ title: "Searched memory", detail: "no files" })
  })

  // Guard proof: in underSearched, return the path as found; every file then starts with
  // `.sixb/agent/ontology/`, and the context folder's whole path.
  test("names each file from the folder searched, which the header names once", () => {
    const ontology = describeGrep({
      input: { pattern: "status", path: "./.sixb/agent/ontology/" },
      output: {
        matches: [
          { path: ".sixb/agent/ontology/customer.md", line: 4, text: "status: active" },
          { path: ".sixb/agent/ontology/customer.md", line: 9, text: "coverageStatus" },
          { path: ".sixb/agent/ontology/types/quote.md", line: 2, text: "status: open" },
        ],
        files: 2,
        more: { ".sixb/agent/ontology/customer.md": 3 },
        truncated: false,
      },
    })
    expect(ontology.path).toBe("./.sixb/agent/ontology/")
    expect(ontology.groups.map(({ path, more }) => ({ path, more }))).toEqual([
      { path: "customer.md", more: 3 },
      { path: "types/quote.md", more: 0 },
    ])

    // On the computer the context folder is outside the working one, and found by its real path.
    const memory = describeGlob({
      input: { pattern: "*.md", path: "/var/folders/x1/T/sixb-agent/t1/.sixb/agent/memory" },
      output: {
        files: [
          "/private/var/folders/x1/T/sixb-agent/t1/.sixb/agent/memory/user/billing.md",
          "/private/var/folders/x1/T/sixb-agent/t1/.sixb/agent/memory/MEMORY.md",
        ],
        truncated: false,
      },
    })
    expect(memory.files).toEqual(["user/billing.md", "MEMORY.md"])

    // A file searched alone keeps its path: it is no folder's.
    const file = describeGrep({
      input: { pattern: "status", path: "src/config.ts" },
      output: {
        matches: [{ path: "src/config.ts", line: 1, text: "status" }],
        files: 1,
        truncated: false,
      },
    })
    expect(file.groups.map((group) => group.path)).toEqual(["src/config.ts"])
  })
})

describe("a matching line", () => {
  test("is cut where the search matched it, as grep matched it", () => {
    const regex = describeGrep({ input: { pattern: "retries" } }).highlight
    expect(highlightLine("Retries = 3", regex)).toEqual([
      { text: "Retries", match: true },
      { text: " = 3", match: false },
    ])

    // An uppercase letter makes the search match case.
    const exact = describeGrep({ input: { pattern: "Retries" } }).highlight
    expect(highlightLine("retries Retries", exact)).toEqual([
      { text: "retries ", match: false },
      { text: "Retries", match: true },
    ])

    const literal = describeGrep({ input: { pattern: "a.b", literal: true } }).highlight
    expect(highlightLine("axb a.b", literal)).toEqual([
      { text: "axb ", match: false },
      { text: "a.b", match: true },
    ])
  })

  // Guard proof: mark every match with `text.matchAll` over a global regex in highlightLine (and
  // searchRegex's flags); the second "retries" is marked, and the pathological line takes seconds.
  test("marks its first match only, the work grep did on it", () => {
    const regex = describeGrep({ input: { pattern: "retries" } }).highlight
    expect(highlightLine("retries = retries", regex)).toEqual([
      { text: "retries", match: true },
      { text: " = retries", match: false },
    ])

    // grep stopped at "aaab"; the rest of the line would backtrack 4 times longer per 2 "a".
    const pathological = describeGrep({ input: { pattern: "(a|a)+b" } }).highlight
    const line = `aaab${"a".repeat(26)}c`
    const started = performance.now()
    expect(highlightLine(line, pathological)).toEqual([
      { text: "aaab", match: true },
      { text: line.slice(4), match: false },
    ])
    expect(performance.now() - started).toBeLessThan(100)
  })

  test("stays whole when the pattern matches nothing visible or does not compile", () => {
    const empty = describeGrep({ input: { pattern: "x*" } }).highlight
    expect(highlightLine("abc", empty)).toEqual([{ text: "abc", match: false }])
    expect(describeGrep({ input: { pattern: "(" } }).highlight).toBeUndefined()
    expect(highlightLine("abc", undefined)).toEqual([{ text: "abc", match: false }])
  })
})

test("a path splits into its folder and its name", () => {
  expect(splitPath("src/queue/worker.ts")).toEqual({ folder: "src/queue/", name: "worker.ts" })
  expect(splitPath("README.md")).toEqual({ folder: "", name: "README.md" })
})

// Removal proof: drop the glob and grep lines from toolProgressLabel (activity-label.ts); the
// closed work then reads "Using glob" and "Using grep".
test("a running search reads as plain progress in the closed work", () => {
  const label = (toolName: string, input: Record<string, unknown>) =>
    latestWorkLabel([{ kind: "tool", tool: { toolName, state: "input-available", input } }])

  expect(label("glob", { pattern: "src/**/*.ts" })).toBe("Looking for files")
  expect(label("grep", { pattern: "retries\\s*=" })).toBe("Searching files")
  expect(label("grep", { pattern: "invoice", path: ".sixb/agent/memory/user" })).toBe(
    "Searching memory"
  )
})
