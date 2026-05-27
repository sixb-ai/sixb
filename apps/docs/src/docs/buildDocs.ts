import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { docsConfig } from "./config"
import { renderHighlightedMarkdown } from "./renderMarkdown"

const outputPath = join(import.meta.dir, "..", "generated", "docs.ts")

const docs = await Promise.all(
  docsConfig.map(async (doc) => {
    const markdown = await Bun.file(doc.sourcePath).text()

    return {
      title: doc.title,
      routePath: doc.routePath,
      markdownPath: doc.markdownPath,
      html: await renderHighlightedMarkdown(markdown, {
        doc,
        docs: docsConfig,
      }),
    }
  })
)

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(
  outputPath,
  `export const docs = ${JSON.stringify(docs, null, 2)} as const\n`,
  "utf-8"
)
