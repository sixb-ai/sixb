import { copyFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { docsConfig } from "./config"

const distDir = join(import.meta.dir, "..", "..", "dist")
const appIndexPath = join(distDir, "index.html")

for (const doc of docsConfig) {
  const markdownOutputPath = join(distDir, doc.markdownPath)
  await mkdir(dirname(markdownOutputPath), { recursive: true })
  await copyFile(doc.sourcePath, markdownOutputPath)

  const routeOutputPath = join(distDir, doc.routePath, "index.html")
  await mkdir(dirname(routeOutputPath), { recursive: true })
  await copyFile(appIndexPath, routeOutputPath)
}
