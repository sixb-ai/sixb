import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"

const repositoryRoot = join(import.meta.dir, "../../..")

async function typescriptFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await typescriptFiles(path)))
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path)
  }
  return files
}

describe("storage provider architecture", () => {
  test("keeps ontology adapters independent from Materializer orchestration", async () => {
    for (const provider of ["pg", "sqlite"]) {
      const root = join(repositoryRoot, `storage/${provider}/src/ontology-storage`)
      for (const file of await typescriptFiles(root)) {
        const contents = await readFile(file, "utf8")
        expect(contents, relative(repositoryRoot, file)).not.toContain(
          "@sixb/core/internal/materializer"
        )
      }
    }
  })
})
