import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { docs } from "../generated/docs"
import { docsConfig } from "./config"

// Public origin of the hosted docs. Defaults to production; override at build time with
// `DOCS_BASE_URL=https://preview.example.com bun run build` for previews.
const baseUrl = (process.env.DOCS_BASE_URL ?? "https://docs.sixb.ai").replace(/\/+$/, "")
const distDir = join(import.meta.dir, "..", "..", "dist")

const tagline =
  "Sixb is a TypeScript framework for operational software. Model your domain as a typed " +
  "ontology, sync live data, and ship automation, a typed API, a client, and apps from one runtime."

type Doc = (typeof docs)[number]
const sourceByMarkdownPath = new Map(docsConfig.map((doc) => [doc.markdownPath, doc.sourcePath]))

// docs is already sorted by section then page order, so consecutive grouping is correct.
const groups: { section: string; items: Doc[] }[] = []
for (const doc of docs) {
  const last = groups.at(-1)
  if (last && last.section === doc.section) last.items.push(doc)
  else groups.push({ section: doc.section, items: [doc] })
}

// llms.txt — curated index pointing at the raw Markdown of every page (llmstxt.org).
let llms = `# Sixb\n\n> ${tagline}\n\nEvery link below points to the page's raw Markdown.\n\n`
for (const group of groups) {
  llms += `## ${group.section}\n\n`
  for (const doc of group.items) {
    const summaryText = doc.summary.replace(/\s+/g, " ").trim()
    const summary = summaryText ? `: ${summaryText}` : ""
    llms += `- [${doc.title}](${baseUrl}${doc.markdownPath})${summary}\n`
  }
  llms += "\n"
}

// llms-full.txt — the whole corpus concatenated for one-shot ingestion.
let full = `# Sixb Documentation\n\n> ${tagline}\n\n`
for (const doc of docs) {
  const sourcePath = sourceByMarkdownPath.get(doc.markdownPath)
  if (!sourcePath) continue
  const markdown = await readFile(sourcePath, "utf-8")
  full += `${markdown.trim()}\n\n---\n\n`
}

// sitemap.xml — one entry per rendered route.
const urls = docs.map((doc) => `  <url><loc>${baseUrl}${doc.routePath}</loc></url>`).join("\n")
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`

// robots.txt — allow all (we want crawlers and LLMs to read the docs), point at the sitemap.
const robots = `User-agent: *\nAllow: /\n\nSitemap: ${baseUrl}/sitemap.xml\n`

await mkdir(distDir, { recursive: true })
await Promise.all([
  writeFile(join(distDir, "llms.txt"), llms, "utf-8"),
  writeFile(join(distDir, "llms-full.txt"), full, "utf-8"),
  writeFile(join(distDir, "sitemap.xml"), sitemap, "utf-8"),
  writeFile(join(distDir, "robots.txt"), robots, "utf-8"),
])

console.log("[SixbDocs] wrote llms.txt, llms-full.txt, sitemap.xml, robots.txt")
