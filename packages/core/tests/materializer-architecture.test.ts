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

const repositoryRoot = join(import.meta.dir, "../../..")

// The Materializer plans and storage applies (src/materializer/README.md): the layers below it, the
// storage providers' ontology adapters included, never depend on it.
test("storage, projection, and neutral contracts never import the materializer layer", async () => {
  const roots = [
    ...["storage", "projections", "materialization"].map((root) => join(sourceRoot, root)),
    ...["pg", "sqlite"].map((provider) =>
      join(repositoryRoot, `storage/${provider}/src/ontology-storage`)
    ),
  ]
  for (const root of roots) {
    for (const file of await typescriptFiles(root)) {
      const contents = await readFile(file, "utf8")
      expect(contents, relative(repositoryRoot, file)).not.toMatch(
        /(?:\bfrom\s*|\bimport\s*\(\s*)["'][^"']*materializer(?:\/|["'])/
      )
    }
  }
})
