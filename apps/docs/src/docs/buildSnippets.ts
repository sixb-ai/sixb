import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { highlightCode } from "@sixb/ui/lib/shiki"
import { renderHighlightedMarkdown } from "./renderMarkdown"
import { walkthroughSources } from "./walkthroughContent"

await mkdir(join(import.meta.dir, "../generated"), { recursive: true })

// The starter keeps the scaffold's behavior, with its HTTP client in a separate file for reading.
const starterFiles = [
  ["sixb.config.ts", "Choose storage and messaging providers."],
  ["connectors/celestrak.ts", "Declare the connector; the HTTP client lives in lib/."],
  ["datasets/satellite-orbit.ts", "Describe the imported rows."],
  ["syncs/satellite-orbit.ts", "Read the connector into a dataset."],
  ["ontology/satellite.ts", "Define the object your app works with."],
  ["projections/satellite.ts", "Map dataset rows to objects."],
  ["app/page.tsx", "Query the objects from a React page."],
  ["lib/celestrak.ts", "HTTP requests, caching, validation, and TLE parsing."],
] as const

async function renderFiles(files: ReadonlyArray<readonly [string, string]>) {
  return Promise.all(
    files.map(async ([path, description]) => {
      const local = path === "connectors/celestrak.ts" || path === "lib/celestrak.ts"
      const base = local
        ? join(import.meta.dir, "../examples/starter")
        : join(import.meta.dir, "../../../../packages/create-sixb/template")
      const code = await Bun.file(join(base, path)).text()
      const lang = path.endsWith(".tsx") ? "tsx" : "ts"
      const formatter = Bun.spawn(
        [
          "bun",
          "x",
          "--no-install",
          "biome",
          "format",
          "--stdin-file-path",
          path,
          "--line-width=64",
        ],
        { stdin: new Blob([code]), stdout: "pipe", stderr: "pipe" }
      )
      const [displayCode, error, exitCode] = await Promise.all([
        new Response(formatter.stdout).text(),
        new Response(formatter.stderr).text(),
        formatter.exited,
      ])
      if (exitCode !== 0) throw new Error(`[SixbDocs] Cannot format ${path}: ${error}`)
      const { html } = await renderHighlightedMarkdown(`\`\`\`${lang}\n${displayCode}\n\`\`\``, {
        doc: { markdownPath: "/" },
        docs: [],
      })
      return { path, description, html, code }
    })
  )
}

const starter = await renderFiles(starterFiles)
await writeFile(
  join(import.meta.dir, "../generated/projectFiles.ts"),
  `export const projects = ${JSON.stringify({
    starter: { title: "my-sixb-app", initialFile: "ontology/satellite.ts", files: starter },
  })} as const\n`
)

// Landing walkthrough: static syntax highlighting, no browser-side highlighter.
const walkthrough = await Promise.all(
  walkthroughSources.map(async (chapter) => ({
    ...chapter,
    files: await Promise.all(
      chapter.files.map(async (file) => ({
        ...file,
        html: await highlightCode(file.code, file.language),
      }))
    ),
  }))
)
await writeFile(
  join(import.meta.dir, "../generated/walkthrough.ts"),
  `export const walkthrough = ${JSON.stringify(walkthrough)} as const\n`
)
