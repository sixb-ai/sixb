import { copyFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { docsConfig } from "./config"

const publicDir = join(import.meta.dir, "..", "..", "public")

for (const doc of docsConfig) {
  const markdownOutputPath = join(publicDir, doc.markdownPath)
  await mkdir(dirname(markdownOutputPath), { recursive: true })
  await copyFile(doc.sourcePath, markdownOutputPath)
}
