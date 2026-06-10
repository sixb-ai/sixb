import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const repoRoot = join(import.meta.dir, "..", "..", "..", "..")
const docsRoot = join(repoRoot, "docs")
const rootReadmePath = join(docsRoot, "README.md")

const readmeDoc = "README.md"
const rootMarkdownPath = "/get-started.md"
const rootRoutePath = "/get-started"

export interface DocConfig {
  readonly title: string
  readonly section: string
  readonly routePath: string
  readonly markdownPath: string
  readonly sourcePath: string
}

export const docsConfig: readonly DocConfig[] = buildDocsConfig()

function buildDocsConfig(): DocConfig[] {
  const order = readDocsOrder()
  return readMarkdownFiles(docsRoot)
    .map((sourcePath) => toDocConfig(sourcePath))
    .sort((left, right) => compareDocs(left, right, order))
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
  const markdown = readFileSync(sourcePath, "utf-8")
  const markdownPath = relativePath === readmeDoc ? rootMarkdownPath : `/${relativePath}`
  const routePath =
    relativePath === readmeDoc ? rootRoutePath : `/${relativePath.replace(/\.md$/, "")}`

  return {
    title: extractTitle(markdown, sourcePath),
    section: sectionForPath(relativePath),
    routePath,
    markdownPath,
    sourcePath,
  }
}

function readDocsOrder(): ReadonlyMap<string, number> {
  const order = new Map<string, number>([[readmeDoc, 0]])

  if (!existsSync(rootReadmePath) || !statSync(rootReadmePath).isFile()) {
    return order
  }

  const markdown = readFileSync(rootReadmePath, "utf-8")
  let index = 1

  for (const match of markdown.matchAll(/\[[^\]]+]\(([^)]+\.md)\)/g)) {
    const relativePath = normalizeRelativePath(join(docsRoot, match[1] ?? ""))
    if (!order.has(relativePath)) {
      order.set(relativePath, index)
      index += 1
    }
  }

  return order
}

function compareDocs(
  left: DocConfig,
  right: DocConfig,
  order: ReadonlyMap<string, number>
): number {
  const leftOrder = order.get(relativeMarkdownPath(left))
  const rightOrder = order.get(relativeMarkdownPath(right))

  if (leftOrder !== undefined && rightOrder !== undefined) {
    return leftOrder - rightOrder
  }

  if (leftOrder !== undefined) return -1
  if (rightOrder !== undefined) return 1

  const section = left.section.localeCompare(right.section)
  if (section !== 0) return section

  return left.title.localeCompare(right.title)
}

function extractTitle(markdown: string, sourcePath: string): string {
  const match = markdown.match(/^#\s+(.+)$/m)
  if (!match?.[1]) {
    throw new Error(`[SixbDocs] Missing top-level heading in ${sourcePath}.`)
  }
  return match[1].trim()
}

function sectionForPath(relativePath: string): string {
  if (relativePath === readmeDoc) return "Get started"
  const [section] = relativePath.split("/")
  if (section === "concepts") return "Core concepts"
  return titleize(section ?? "Docs")
}

function relativeMarkdownPath(doc: DocConfig): string {
  return normalizeRelativePath(doc.sourcePath)
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
