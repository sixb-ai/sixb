import { cp, mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { docsConfig } from "./config"
import { exportMarkdown } from "./exportMarkdown"

const publicDir = join(import.meta.dir, "..", "..", "public")

for (const doc of docsConfig) {
  const markdownOutputPath = join(publicDir, doc.markdownPath)
  await mkdir(dirname(markdownOutputPath), { recursive: true })
  await writeFile(markdownOutputPath, exportMarkdown(await Bun.file(doc.sourcePath).text()))
}

await cp(join(import.meta.dir, "../../assets"), join(publicDir, "assets"), { recursive: true })
// Connector icons ship with Atlas; the connector library serves the same files.
await cp(
  join(import.meta.dir, "../../../../packages/atlas/src/connector-icons"),
  join(publicDir, "assets", "connectors"),
  { recursive: true }
)
