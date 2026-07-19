import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"

const sourceRoot = join(import.meta.dir, "../src")

async function typescriptFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await typescriptFiles(path)))
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path)
  }
  return files
}

describe("materializer architecture", () => {
  test("keeps the materializer root as a small public composition surface", async () => {
    const entries = await readdir(join(sourceRoot, "materializer"), { withFileTypes: true })
    const rootFiles = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()

    expect(rootFiles).toEqual(["context.ts", "index.ts", "materializer.ts"])
    expect(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    ).toEqual(["edits", "effective", "execution", "projections", "shared", "telemetry"])
  })

  test("prevents storage, projection, and neutral contracts from importing the application layer", async () => {
    for (const root of ["storage", "projections", "materialization"]) {
      for (const file of await typescriptFiles(join(sourceRoot, root))) {
        const contents = await readFile(file, "utf8")
        expect(contents, relative(sourceRoot, file)).not.toMatch(
          /(?:from|import\()["'][^"']*materializer(?:\/|["'])/
        )
      }
    }
  })
})
