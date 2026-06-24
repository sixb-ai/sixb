import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { docsConfig } from "./config"
import { renderHighlightedMarkdown } from "./renderMarkdown"

const outputPath = join(import.meta.dir, "..", "generated", "docs.ts")

const docs = await Promise.all(
  docsConfig.map(async (doc) => {
    const markdown = await Bun.file(doc.sourcePath).text()
    const rendered = await renderHighlightedMarkdown(markdown, { doc, docs: docsConfig })

    return {
      title: doc.title,
      section: doc.section,
      sectionIndex: doc.sectionIndex,
      isOverview: doc.isOverview,
      routePath: doc.routePath,
      markdownPath: doc.markdownPath,
      summary: rendered.summary,
      headings: rendered.headings,
      html: rendered.html,
    }
  })
)

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(
  outputPath,
  `import type { DocEntry } from "../docs/types"\n\nexport const docs: readonly DocEntry[] = ${JSON.stringify(docs, null, 2)}\n`,
  "utf-8"
)
