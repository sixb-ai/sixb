import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import { sections } from "./sections"

const repoRoot = join(import.meta.dir, "..", "..", "..", "..")
const docsRoot = join(repoRoot, "docs")

const readmeDoc = "README.md"
const overviewDoc = "overview.md"
const getStartedRoutePath = "/get-started"
// The root README keeps its natural markdown path so relative `../README.md`
// links from any page resolve to it; only its route is the friendly /get-started.
const rootReadmeMarkdownPath = "/README.md"

export interface DocConfig {
  readonly title: string
  readonly section: string
  readonly sectionIndex: number
  readonly folder: string
  readonly isOverview: boolean
  readonly routePath: string
  readonly markdownPath: string
  readonly sourcePath: string
}

const orderCache = new Map<string, ReadonlyMap<string, number>>()

export const docsConfig: readonly DocConfig[] = buildDocsConfig()

function buildDocsConfig(): DocConfig[] {
  return readMarkdownFiles(docsRoot)
    .map((sourcePath) => toDocConfig(sourcePath))
    .sort(compareDocs)
}

function readMarkdownFiles(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true })
  const markdownFiles: string[] = []

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      markdownFiles.push(...readMarkdownFiles(path))
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      markdownFiles.push(path)
    }
  }

  return markdownFiles
}

function toDocConfig(sourcePath: string): DocConfig {
  const relativePath = normalizeRelativePath(sourcePath)
  const folder = folderForPath(relativePath)
  const name = basename(relativePath)
  const isRootReadme = relativePath === readmeDoc
  const isOverview = isRootReadme || name === overviewDoc
  const markdown = readFileSync(sourcePath, "utf-8")

  return {
    title: extractTitle(markdown, sourcePath),
    section: sectionForFolder(folder),
    sectionIndex: sectionIndexForFolder(folder),
    folder,
    isOverview,
    routePath: routePathFor(relativePath, folder, isRootReadme, isOverview),
    markdownPath: isRootReadme ? rootReadmeMarkdownPath : `/${relativePath}`,
    sourcePath,
  }
}

function routePathFor(
  relativePath: string,
  folder: string,
  isRootReadme: boolean,
  isOverview: boolean
): string {
  if (isRootReadme) return getStartedRoutePath
  if (isOverview && folder) return `/${folder}`
  return `/${relativePath.replace(/\.md$/, "")}`
}

function folderForPath(relativePath: string): string {
  const segments = relativePath.split("/")
  return segments.length > 1 ? (segments[0] ?? "") : ""
}

function sectionForFolder(folder: string): string {
  const def = sections.find((section) => section.folder === folder)
  return def ? def.title : titleize(folder || "Docs")
}

function sectionIndexForFolder(folder: string): number {
  const index = sections.findIndex((section) => section.folder === folder)
  return index === -1 ? sections.length : index
}

function sectionPageOrder(folder: string): ReadonlyMap<string, number> {
  const cached = orderCache.get(folder)
  if (cached) return cached

  const order = new Map<string, number>()
  const metaPath = join(docsRoot, folder, "_meta.json")

  if (existsSync(metaPath) && statSync(metaPath).isFile()) {
    try {
      const parsed = JSON.parse(readFileSync(metaPath, "utf-8")) as unknown
      if (Array.isArray(parsed)) {
        parsed.forEach((entry, index) => {
          if (typeof entry === "string") order.set(entry, index)
        })
      }
    } catch {
      // Malformed _meta.json falls back to overview-first then alphabetical.
    }
  }

  orderCache.set(folder, order)
  return order
}

function compareDocs(left: DocConfig, right: DocConfig): number {
  if (left.sectionIndex !== right.sectionIndex) {
    return left.sectionIndex - right.sectionIndex
  }

  const order = sectionPageOrder(left.folder)
  const leftRank = pageRank(left, order)
  const rightRank = pageRank(right, order)
  if (leftRank !== rightRank) return leftRank - rightRank

  return left.title.localeCompare(right.title)
}

function pageRank(doc: DocConfig, order: ReadonlyMap<string, number>): number {
  if (doc.isOverview) return -1
  const rank = order.get(basename(normalizeRelativePath(doc.sourcePath)))
  return rank ?? Number.MAX_SAFE_INTEGER
}

function extractTitle(markdown: string, sourcePath: string): string {
  const match = markdown.match(/^#\s+(.+)$/m)
  if (!match?.[1]) {
    throw new Error(`[SixbDocs] Missing top-level heading in ${sourcePath}.`)
  }
  return match[1].trim()
}

function normalizeRelativePath(path: string): string {
  return path
    .replace(docsRoot, "")
    .replace(/^[/\\]+/, "")
    .replaceAll("\\", "/")
}

function titleize(value: string): string {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ")
}
