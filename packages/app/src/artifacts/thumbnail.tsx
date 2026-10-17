import { getArtifactVersionOptions } from "@sixb/client/hooks"
import { Markdown, type MarkdownProps } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { type ReactNode, useMemo } from "react"
import type { FileSource } from "./file-source"
import { fileView } from "./file-view"
import type { ArtifactKindName } from "./kind-icon"
import { type ArtifactVersion, useFileText, versionFileSource, versionImageSource } from "./queries"
import { parseDelimitedText } from "./renderers/delimited"
import { rehypeArtifactDocument } from "./renderers/document-tree"

// A miniature is the real content laid out at page width and scaled onto a sheet, the way a file
// browser previews a document: the title, the paragraphs, and the figures are where they will be.
const PAGE_WIDTH = 440
const SCALE = 0.1
/** Only the top of the page shows, so only its start is rendered. */
const EXCERPT_CHARACTERS = 1_600
const REHYPE_PLUGINS: MarkdownProps["rehypePlugins"] = [rehypeArtifactDocument]

/** A version's miniature: a document's first page, an image, a table, or a labelled sheet. */
export function ArtifactThumbnail({
  artifactId,
  version,
  kind,
  className,
}: {
  readonly artifactId: string
  readonly version: number
  readonly kind: ArtifactKindName
  readonly className?: string
}) {
  const query = useQuery({
    ...getArtifactVersionOptions({ path: { artifactId, version: String(version) } }),
    // A version never changes once published.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
  const data = query.data
  const source = data ? versionFileSource(data, data.entry) : null
  return (
    <Tile className={className}>
      {!data ? (
        <Sheet loading={query.isLoading} />
      ) : kind === "document" ? (
        <DocumentSheet version={data} />
      ) : source ? (
        <FileArt source={source} />
      ) : (
        <Sheet />
      )}
    </Tile>
  )
}

/** A file's miniature on its own, for files that are not artifacts, such as attachments. */
export function FileThumbnail({
  source,
  className,
}: {
  readonly source: FileSource
  readonly className?: string
}) {
  return (
    <Tile className={className}>
      <FileArt source={source} />
    </Tile>
  )
}

function Tile({
  className,
  children,
}: {
  readonly className?: string
  readonly children: ReactNode
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative block size-16 shrink-0 overflow-hidden rounded-xl bg-muted ring-1 ring-black/[0.04] ring-inset dark:ring-white/[0.06]",
        className
      )}
    >
      {children}
    </span>
  )
}

/**
 * A sheet of paper hanging in the tile, cut off at its foot. It lifts when the card around it is
 * hovered.
 */
function Sheet({
  loading = false,
  label,
  children,
}: {
  readonly loading?: boolean
  readonly label?: { readonly text: string; readonly className: string }
  readonly children?: ReactNode
}) {
  return (
    <span className="absolute inset-x-[10px] top-[10px] -bottom-2 overflow-hidden rounded-t-[4px] bg-background shadow-[0_1px_2px_rgb(0_0_0/0.08),0_2px_8px_rgb(0_0_0/0.06)] ring-1 ring-black/[0.06] transition-transform duration-200 ease-out group-hover:-translate-y-0.5 dark:ring-white/10">
      {children ?? <Lines pulse={loading} />}
      {label ? (
        <span
          className={cn(
            "absolute bottom-3 left-1.5 rounded-[3px] px-1 py-px text-[7px] leading-none font-semibold tracking-wide text-white uppercase",
            label.className
          )}
        >
          {label.text}
        </span>
      ) : null}
    </span>
  )
}

/** Placeholder text lines: a title and a paragraph. */
function Lines({ pulse = false }: { readonly pulse?: boolean }) {
  return (
    <span className={cn("flex flex-col gap-[3px] px-[6px] pt-[7px]", pulse && "animate-pulse")}>
      <span className="h-[3px] w-3/4 rounded-full bg-foreground/25" />
      <span className="mt-[2px] h-[2px] w-full rounded-full bg-foreground/10" />
      <span className="h-[2px] w-full rounded-full bg-foreground/10" />
      <span className="h-[2px] w-5/6 rounded-full bg-foreground/10" />
      <span className="h-[2px] w-full rounded-full bg-foreground/10" />
      <span className="h-[2px] w-2/3 rounded-full bg-foreground/10" />
    </span>
  )
}

/** The real content, laid out at page width and scaled down to the sheet. */
function Miniature({ children }: { readonly children: ReactNode }) {
  return (
    <span
      className="pointer-events-none block origin-top-left select-none"
      style={{ width: PAGE_WIDTH, transform: `scale(${SCALE})` }}
    >
      {children}
    </span>
  )
}

function DocumentSheet({ version }: { readonly version: ArtifactVersion }) {
  const { text } = useFileText(versionFileSource(version, "document.md"))
  const markdown = useMemo(() => (text === undefined ? undefined : excerpt(text)), [text])
  const components = useMemo<NonNullable<MarkdownProps["components"]>>(
    () => ({
      img({ node: _node, src, alt }) {
        const source = typeof src === "string" ? versionImageSource(version, src) : null
        return source ? <img src={source.inlineUrl} alt={alt ?? ""} /> : null
      },
    }),
    [version]
  )
  if (markdown === undefined) return <Sheet loading />
  return (
    <Sheet>
      <Miniature>
        <span className="block px-9 pt-9">
          <Markdown
            className="sixb-document"
            components={components}
            rehypePlugins={REHYPE_PLUGINS}
          >
            {markdown}
          </Markdown>
        </span>
      </Miniature>
    </Sheet>
  )
}

/** A file as its type allows: the image itself, a table's first rows, text, or a labelled sheet. */
function FileArt({ source }: { readonly source: FileSource }) {
  const view = fileView(source.fileRef)
  if (view === "image") {
    return <img src={source.inlineUrl} alt="" className="absolute inset-0 size-full object-cover" />
  }
  if (view === "csv" || view === "tsv") return <TableSheet source={source} kind={view} />
  if (view === "markdown" || view === "text")
    return <TextSheet source={source} markdown={view === "markdown"} />
  return <Sheet label={formatLabel(source.name)} />
}

function TableSheet({
  source,
  kind,
}: {
  readonly source: FileSource
  readonly kind: "csv" | "tsv"
}) {
  const { text } = useFileText(source)
  const table = useMemo(() => {
    if (text === undefined) return null
    try {
      return parseDelimitedText(text.slice(0, 4_000), kind)
    } catch {
      return null
    }
  }, [text, kind])
  if (!table) return <Sheet loading={text === undefined} label={formatLabel(source.name)} />
  const columns = table.headers.slice(0, 4)
  return (
    <Sheet>
      <Miniature>
        <span className="block px-6 pt-8">
          <table className="w-full border-collapse text-[22px] text-foreground">
            <thead>
              <tr>
                {columns.map((header, index) => (
                  <th
                    key={index}
                    className="border-b-[3px] border-foreground/20 px-2 pb-3 text-left font-semibold"
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.slice(0, 12).map((row, rowIndex) => (
                <tr key={rowIndex} className="text-foreground/60">
                  {columns.map((_, index) => (
                    <td key={index} className="border-b-2 border-foreground/10 px-2 py-2.5">
                      {row[index]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </span>
      </Miniature>
    </Sheet>
  )
}

function TextSheet({
  source,
  markdown,
}: {
  readonly source: FileSource
  readonly markdown: boolean
}) {
  const { text } = useFileText(source)
  if (text === undefined) return <Sheet loading />
  const start = excerpt(text)
  return (
    <Sheet>
      <Miniature>
        <span className="block px-9 pt-9">
          {markdown ? (
            <Markdown>{start}</Markdown>
          ) : (
            <pre className="m-0 font-mono text-[15px] leading-relaxed whitespace-pre-wrap text-foreground/80">
              {start}
            </pre>
          )}
        </span>
      </Miniature>
    </Sheet>
  )
}

/** The start of a text, cut at a line break so no half-parsed construct ends the excerpt. */
function excerpt(text: string): string {
  if (text.length <= EXCERPT_CHARACTERS) return text
  const cut = text.lastIndexOf("\n", EXCERPT_CHARACTERS)
  return text.slice(0, cut > 0 ? cut : EXCERPT_CHARACTERS)
}

// Format labels in the colors their families are known by, so a PDF reads as a PDF at a glance.
const FORMAT_COLORS: readonly [RegExp, string][] = [
  [/^pdf$/, "bg-[#e5484d]"],
  [/^(docx?|rtf|odt|pages)$/, "bg-[#3e63dd]"],
  [/^(xlsx?|ods|numbers|csv|tsv)$/, "bg-[#30a46c]"],
  [/^(pptx?|odp|key)$/, "bg-[#f76b15]"],
  [/^(html?|xml|json|ya?ml)$/, "bg-[#8e4ec6]"],
  [/^(zip|tar|gz|tgz|7z|rar)$/, "bg-[#6f6e77]"],
]

function formatLabel(
  name: string
): { readonly text: string; readonly className: string } | undefined {
  const extension = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase()
  if (!extension) return undefined
  const color =
    FORMAT_COLORS.find(([pattern]) => pattern.test(extension))?.[1] ?? "bg-foreground/50"
  return { text: extension, className: color }
}
