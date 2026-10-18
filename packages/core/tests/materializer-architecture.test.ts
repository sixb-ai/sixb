import { expect, test } from "bun:test"
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

// The Materializer plans and storage applies (src/materializer/README.md): the layers below it never
// depend on it.
test("storage, projection, and neutral contracts never import the materializer layer", async () => {
  for (const root of ["storage", "projections", "materialization"]) {
    for (const file of await typescriptFiles(join(sourceRoot, root))) {
      const contents = await readFile(file, "utf8")
      expect(contents, relative(sourceRoot, file)).not.toMatch(
        /(?:from|import\()["'][^"']*materializer(?:\/|["'])/
      )
    }
  }
})
