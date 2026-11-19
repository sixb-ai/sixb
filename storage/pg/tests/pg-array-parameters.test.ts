import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

// A list goes to Postgres as a plain JavaScript array, `ANY(${ids}::text[])`, never through
// postgres.js's `sql.array(ids)`. Built before the client has read the server's array types, which
// its first query does, `sql.array` of one element is sent as that element alone: Postgres refuses
// it as a malformed array literal, so the first query a process runs with one id fails. The
// artifact storage contract's "reads one board's pictures first" shows it on a real server.
//
// Reproduce by writing `this.sql.array(...)` back into any query of `src`.

const SRC = join(import.meta.dir, "../src")

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith(".ts") ? [path] : []
  })
}

describe("lists sent to Postgres", () => {
  test("are plain arrays, never postgres.js's sql.array", () => {
    const uses = sources(SRC).flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          /\b(?:sql|tx)\.array\(/.test(line) ? [`${relative(SRC, path)}:${index + 1}`] : []
        )
    )
    expect(uses).toEqual([])
  })
})
