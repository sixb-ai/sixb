import { type CsvTable, parseCsv, type WorkbookChart } from "@sixb/core/artifacts"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { AreaChart as AreaIcon, ChartColumn, ChartLine, ChartPie } from "lucide-react"
import { type ReactNode, useMemo } from "react"
import { fileExtension, versionSummary } from "./card-details"
import { formatFileSize } from "./file-size"
import type { FileSource } from "./file-source"
import { fileView } from "./file-view"
import { ArtifactKindIcon, type ArtifactKindName } from "./kind-icon"
import { useArtifactMessages } from "./messages"
import { type ArtifactVersion, useArtifactTheme, useFileText, versionFileSource } from "./queries"
import { PageFace } from "./renderers/page"
import { chartData } from "./renderers/sheet/chart-data"
import { previewFormatter } from "./renderers/sheet/format"
import { MiniChart } from "./renderers/sheet/mini-chart"
import { fileSheetModel, type SheetModel } from "./renderers/sheet/model"
import { useSheetModel, useWorkbook } from "./renderers/sheet/workbook"
import { artifactThemeAttributes } from "./theme"

/**
 * How much of a text a preview reads: a table's first rows, a document's opening, or a text's
 * first lines. The file itself is fetched whole, so a chart, which draws every row, reads it all.
 */
const EXCERPT_CHARACTERS = 2_000
const PREVIEW_COLUMNS = 3
const TAB_LIMIT = 4

/**
 * What a card shows of an artifact, at a size that reads: a workbook's first chart or first rows
 * above its tabs, a document's title and lede in its own type and theme, an image, the start of a
 * text, or a file's format. It fills the pane the card gives it.
 */
export function ArtifactPreview({
  version,
  kind,
  loading,
}: {
  readonly version: ArtifactVersion | undefined
  readonly kind: ArtifactKindName
  readonly loading: boolean
}) {
  if (!version) return <Skeleton pulse={loading} />
  return <VersionPreview version={version} kind={kind} />
}

/**
 * A card's face, wherever an artifact shows as a card: its preview above its kind, its title, and
 * what it holds. The control around it decides what a click does.
 */
export function ArtifactCardFace({
  kind,
  title,
  version,
  loading,
}: {
  readonly kind: ArtifactKindName
  readonly title: string
  readonly version: ArtifactVersion | undefined
  readonly loading: boolean
}) {
  const locale = useLocale()
  const messages = useArtifactMessages()
  return (
    <>
      <span
        aria-hidden="true"
        className="relative block h-[7.75rem] overflow-hidden border-b border-border/70"
      >
        <ArtifactPreview kind={kind} version={version} loading={loading} />
      </span>
      <ArtifactLabel
        title={title}
        detail={version ? versionSummary(version, messages, locale) : messages.kinds[kind]}
        icon={<ArtifactKindIcon kind={kind} className="size-4 shrink-0 text-muted-foreground" />}
        className="px-3.5 py-3"
      />
    </>
  )
}

/**
 * An artifact's title over a line about it, beside an icon, as its cards and lines show it. What
 * comes `after` the line, such as a date, stays whole where the line itself is cut off.
 */
export function ArtifactLabel({
  title,
  detail,
  after,
  icon,
  large = false,
  className,
}: {
  readonly title: string
  readonly detail: string
  readonly after?: ReactNode
  readonly icon: ReactNode
  /** The gallery's size, a step up from a conversation's. */
  readonly large?: boolean
  readonly className?: string
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2.5", className)}>
      {icon}
      <span className={cn("flex min-w-0 flex-1 flex-col", large && "gap-0.5")}>
        {/* `cn` drops a line height that comes before a font size, so each size comes first. */}
        <span
          className={cn(
            large ? "text-[14px]" : "text-[13.5px]",
            "truncate leading-snug font-medium text-foreground"
          )}
          title={title}
        >
          {title}
        </span>
        <span
          className={cn(
            large ? "text-[12.5px]" : "text-[12px]",
            "flex min-w-0 items-center gap-1.5 leading-snug text-muted-foreground tabular-nums"
          )}
        >
          <span className="truncate">{detail}</span>
          {after}
        </span>
      </span>
    </span>
  )
}

function VersionPreview({
  version,
  kind,
}: {
  readonly version: ArtifactVersion
  readonly kind: ArtifactKindName
}) {
  // The artifact's own theme, so a dark or branded document previews the way it opens. A file
  // artifact named `theme.json` is that file, not a theme.
  const ownTheme = useArtifactTheme(version)
  const theme = artifactThemeAttributes(kind === "file" ? null : ownTheme)
  const source = versionFileSource(version, version.entry)
  return (
    <div
      className={cn("absolute inset-0 bg-card text-card-foreground", theme.className)}
      style={theme.style}
    >
      {kind === "document" ? (
        <DocumentPreview version={version} />
      ) : kind === "sheet" ? (
        <WorkbookPreview version={version} />
      ) : kind === "slides" ? (
        <DeckPreview version={version} />
      ) : kind === "page" ? (
        <PageFace version={version} />
      ) : source ? (
        <FilePreview source={source} />
      ) : (
        <Skeleton />
      )}
    </div>
  )
}

function DocumentPreview({ version }: { readonly version: ArtifactVersion }) {
  const { text, loading } = useFileText(versionFileSource(version, version.entry))
  const opening = useMemo(() => (text === undefined ? null : documentOpening(text)), [text])
  if (loading) return <Skeleton pulse />
  const sections =
    version.outline.kind === "document"
      ? version.outline.headings
          .filter((heading) => heading.depth === 2)
          .map((heading) => heading.text)
      : []
  // A document too large to preview, or one that did not load, still has its title and outline.
  return (
    <Opening title={opening?.title ?? version.title} lede={opening?.lede} sections={sections} />
  )
}

/**
 * A title set as the document sets it, and the lede beneath it; a document that opens without one
 * shows the start of its outline instead.
 */
function Opening({
  title,
  lede,
  sections = [],
}: {
  readonly title: string
  readonly lede?: string
  readonly sections?: readonly string[]
}) {
  return (
    <Faded>
      <span className="line-clamp-2 font-serif text-[18px] leading-[1.2] font-semibold tracking-[-0.01em] text-foreground">
        {title}
      </span>
      {lede ? (
        <span className="mt-1.5 line-clamp-3 text-[12px] leading-[1.5] text-muted-foreground">
          {lede}
        </span>
      ) : sections.length > 0 ? (
        <span className="mt-2.5 flex flex-col gap-1 border-l border-border pl-2.5 text-[11.5px] leading-4 text-muted-foreground">
          {sections.slice(0, 4).map((section, index) => (
            <span key={`${index}:${section}`} className="truncate">
              {section}
            </span>
          ))}
        </span>
      ) : null}
    </Faded>
  )
}

/** A deck's first slide in miniature, on the ground a deck's card sets it on. */
function DeckPreview({ version }: { readonly version: ArtifactVersion }) {
  return (
    <span className="flex h-full items-center justify-center bg-muted/70 p-3">
      <span className="relative aspect-video h-full max-w-full overflow-hidden rounded-[4px] bg-background shadow-[0_1px_2px_rgb(0_0_0/0.08),0_4px_14px_rgb(0_0_0/0.07)] ring-1 ring-black/[0.05] dark:ring-white/10">
        <SlideFace version={version} />
      </span>
    </span>
  )
}

/**
 * A deck's first slide set as a title slide, from what publishing read of the deck: its title, and
 * how many slides there are. It fills the slide it is put in, with type scaled to that slide's
 * width, so it also stands in for a deck's live first slide until, or unless, that shows.
 */
export function SlideFace({ version }: { readonly version: ArtifactVersion }) {
  const messages = useArtifactMessages().slides
  const slides = version.outline.kind === "slides" ? version.outline.slides : []
  const title = slides.find((slide) => slide.title)?.title ?? version.title
  return (
    <span className="@container absolute inset-0 flex flex-col justify-center px-[9%]">
      <span className="line-clamp-3 text-[7.3cqw] leading-[1.15] font-semibold tracking-[-0.015em] text-foreground">
        {title}
      </span>
      <span className="mt-[3.4cqw] h-[1.7cqw] w-1/3 rounded-full bg-foreground/15" />
      <span className="absolute right-[6%] bottom-[7%] text-[4.5cqw] text-muted-foreground tabular-nums">
        {messages.position(1, slides.length)}
      </span>
    </span>
  )
}

/**
 * A workbook as a spreadsheet app shows one: its first chart, or its first sheet's first rows,
 * above its tabs.
 */
function WorkbookPreview({ version }: { readonly version: ArtifactVersion }) {
  const locale = useLocale()
  const { workbook, loading: reading } = useWorkbook(version)
  const chart = workbook?.charts[0]
  const sheets = workbook?.sheets
  const sheet = sheets?.find((entry) => entry.name === chart?.sheet) ?? sheets?.[0]
  // The whole sheet, as the viewer reads it: a chart draws every row, and its latest value is the
  // last row's.
  const { model, loading } = useSheetModel(version, sheet)
  const latest = useMemo(
    () => (chart && model ? latestValue(chart, model, locale) : undefined),
    [chart, model, locale]
  )
  if (!workbook || !model) return <Skeleton pulse={reading || loading} />

  const tabs = [
    ...workbook.sheets.map((entry) => ({
      key: `sheet:${entry.name}`,
      label: entry.name,
      chart: undefined,
      active: !chart && entry.name === sheet?.name,
    })),
    ...workbook.charts.map((entry) => ({
      key: `chart:${entry.name}`,
      label: entry.title ?? entry.name,
      chart: entry.type,
      active: entry.name === chart?.name,
    })),
  ]
  return (
    <span className="flex h-full flex-col">
      {chart ? (
        <span className="flex min-h-0 flex-1 flex-col px-4 pt-3 pb-2.5">
          <span className="flex items-baseline gap-2 text-[11.5px]">
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">
              {chart.title ?? chart.name}
            </span>
            {latest ? (
              <span className="shrink-0 font-semibold text-foreground tabular-nums">{latest}</span>
            ) : null}
          </span>
          <span className="mt-2 min-h-0 flex-1">
            <MiniChart chart={chart} model={model} />
          </span>
        </span>
      ) : (
        <span className="min-h-0 flex-1 overflow-hidden">
          <TablePreview model={model} rows={3} />
        </span>
      )}
      <span className="flex h-[22px] shrink-0 items-stretch overflow-hidden border-t border-border/70 bg-muted/50 px-1.5 text-[10.5px] [mask-image:linear-gradient(to_right,black_85%,transparent)]">
        {tabs.slice(0, TAB_LIMIT).map((tab) => (
          <span
            key={tab.key}
            className={cn(
              "flex max-w-28 shrink-0 items-center gap-1 px-2",
              tab.active
                ? "bg-card font-medium text-foreground shadow-[1px_0_0_var(--border),-1px_0_0_var(--border)]"
                : "text-muted-foreground"
            )}
          >
            {tab.chart ? <ChartGlyph type={tab.chart} /> : null}
            <span className="truncate">{tab.label}</span>
          </span>
        ))}
        {tabs.length > TAB_LIMIT ? (
          <span className="flex shrink-0 items-center px-1.5 text-muted-foreground tabular-nums">
            +{tabs.length - TAB_LIMIT}
          </span>
        ) : null}
      </span>
    </span>
  )
}

/** A chart's latest value, as its full view labels it: the last row's first series, for a glance. */
function latestValue(chart: WorkbookChart, model: SheetModel, locale: string): string | undefined {
  if (chart.type === "pie") return undefined
  const data = chartData(chart, model)
  const series = data?.series[0]
  const value = series ? data.rows.at(-1)?.[series.key] : undefined
  return typeof value === "number" && series
    ? previewFormatter(series.column, locale)(String(value)).text
    : undefined
}

function ChartGlyph({ type }: { readonly type: WorkbookChart["type"] }) {
  const Icon =
    type === "line"
      ? ChartLine
      : type === "area"
        ? AreaIcon
        : type === "pie"
          ? ChartPie
          : ChartColumn
  return <Icon className="size-3 shrink-0" aria-hidden="true" />
}

/** A table's first rows and columns, with numbers right-aligned and formatted for a glance. */
function TablePreview({
  model,
  rows: rowCount,
}: {
  readonly model: SheetModel
  readonly rows: number
}) {
  const locale = useLocale()
  const indexes = useMemo(() => previewColumns(model), [model])
  const rows = useMemo(() => {
    const formatters = indexes.map((index) => {
      const column = model.columns[index]
      return column ? previewFormatter(column, locale) : null
    })
    return model.rows
      .slice(0, rowCount)
      .map((row) =>
        indexes.map((column, index) => formatters[index]?.(row[column] ?? "") ?? { text: "" })
      )
  }, [model, indexes, locale, rowCount])
  const columns = indexes.flatMap((index) => model.columns[index] ?? [])
  return (
    <span
      className="grid gap-x-3 gap-y-[3px] px-4 pt-3.5 text-[12px] leading-[18px] tabular-nums"
      style={{
        gridTemplateColumns: columns
          .map((column, index) =>
            index === 0 && !column.numeric ? "minmax(0,1.4fr)" : "minmax(0,1fr)"
          )
          .join(" "),
      }}
    >
      {columns.map((column) => (
        <span
          key={column.name}
          className={cn(
            "min-w-0 truncate pb-0.5 text-[11px] font-medium text-muted-foreground",
            column.numeric && "text-right"
          )}
        >
          {column.name}
        </span>
      ))}
      {rows.flatMap((row, rowIndex) =>
        row.map((cell, index) => (
          <span
            key={`${rowIndex}:${index}`}
            className={cn(
              "min-w-0 truncate",
              columns[index]?.numeric && "text-right",
              cell.negative ? "text-destructive" : "text-foreground"
            )}
          >
            {cell.text}
          </span>
        ))
      )}
    </span>
  )
}

/**
 * The columns a preview shows, in the sheet's order: the first, which usually names each row,
 * then numbers, which read at a glance where text would be cut off, then whatever is left.
 */
export function previewColumns(model: SheetModel): number[] {
  const rest = model.columns.map((_, index) => index).slice(1)
  const numeric = rest.filter((index) => model.columns[index]?.numeric)
  const others = rest.filter((index) => !model.columns[index]?.numeric)
  const chosen = [...(model.columns.length > 0 ? [0] : []), ...numeric, ...others]
  return chosen.slice(0, PREVIEW_COLUMNS).sort((a, b) => a - b)
}

/** A file as its type allows: the image, a table's first rows, a text's start, or its format. */
function FilePreview({ source }: { readonly source: FileSource }) {
  const view = fileView(source.fileRef)
  if (view === "image") {
    return <img src={source.inlineUrl} alt="" className="absolute inset-0 size-full object-cover" />
  }
  if (view === "csv" || view === "tsv") return <FileTablePreview source={source} kind={view} />
  if (view === "markdown" || view === "text") {
    return <TextPreview source={source} markdown={view === "markdown"} />
  }
  return <FormatPreview source={source} />
}

function FileTablePreview({
  source,
  kind,
}: {
  readonly source: FileSource
  readonly kind: "csv" | "tsv"
}) {
  const { text, loading } = useFileText(source)
  const model = useMemo(() => {
    const table = text === undefined ? null : tableStart(text, kind)
    return table ? fileSheetModel(source.name, table) : null
  }, [text, kind, source.name])
  if (model) return <TablePreview model={model} rows={4} />
  // A file too large to preview, or one that did not load, shows as its format.
  return loading ? <Skeleton pulse /> : <FormatPreview source={source} />
}

function TextPreview({
  source,
  markdown,
}: {
  readonly source: FileSource
  readonly markdown: boolean
}) {
  const { text, loading } = useFileText(source)
  const opening = useMemo(
    () => (markdown && text !== undefined ? documentOpening(text) : null),
    [markdown, text]
  )
  if (text === undefined) return loading ? <Skeleton pulse /> : <FormatPreview source={source} />
  if (opening?.title) return <Opening title={opening.title} lede={opening.lede} />
  return (
    <Faded>
      <span className="font-mono text-[10.5px] leading-[1.55] whitespace-pre text-muted-foreground">
        {excerpt(text).split("\n").slice(0, 8).join("\n")}
      </span>
    </Faded>
  )
}

/** A file that does not show in place: its format on a page, with its name and size. */
function FormatPreview({ source }: { readonly source: FileSource }) {
  const locale = useLocale()
  const units = useArtifactMessages().files
  const format = fileFormat(source.name)
  return (
    <span className="flex h-full flex-col items-center justify-center gap-2.5 px-4">
      <span className="relative h-[52px] w-[42px] rounded-[5px] bg-background shadow-[0_1px_2px_rgb(0_0_0/0.08),0_3px_10px_rgb(0_0_0/0.06)] ring-1 ring-black/[0.07] dark:ring-white/10">
        <span className="absolute inset-x-[7px] top-[9px] flex flex-col gap-[3px]">
          <span className="h-[2px] w-full rounded-full bg-foreground/15" />
          <span className="h-[2px] w-full rounded-full bg-foreground/15" />
          <span className="h-[2px] w-2/3 rounded-full bg-foreground/15" />
        </span>
        {format ? (
          <span
            className={cn(
              "absolute bottom-[6px] left-[5px] rounded-[3px] px-[3px] py-px text-[8px] leading-none font-semibold tracking-wide text-white uppercase",
              format.className
            )}
          >
            {format.text}
          </span>
        ) : null}
      </span>
      <span className="flex max-w-full flex-col items-center text-center">
        <span className="max-w-full truncate text-[11.5px] font-medium text-foreground">
          {source.name}
        </span>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {formatFileSize(source.fileRef.sizeBytes, locale, units)}
        </span>
      </span>
    </span>
  )
}

/** Content from the top of the pane, fading out where the pane cuts it off. */
function Faded({ children }: { readonly children: ReactNode }) {
  return (
    <span className="flex h-full flex-col px-4 pt-3.5 [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">
      {children}
    </span>
  )
}

function Skeleton({ pulse = false }: { readonly pulse?: boolean }) {
  return (
    <span className={cn("flex flex-col gap-2 px-4 pt-4", pulse && "animate-pulse")}>
      <span className="h-3 w-2/3 rounded-full bg-muted" />
      <span className="h-2 w-full rounded-full bg-muted" />
      <span className="h-2 w-5/6 rounded-full bg-muted" />
      <span className="h-2 w-3/4 rounded-full bg-muted" />
    </span>
  )
}

/**
 * A Markdown text's opening as its document page sets it: the first `#` heading is the title,
 * and the paragraph straight after it is the lede, in plain words.
 */
export function documentOpening(markdown: string): {
  readonly title?: string
  readonly lede?: string
} {
  const lines = excerpt(markdown).split("\n")
  const titleIndex = lines.findIndex((line) => /^#\s+\S/.test(line))
  if (titleIndex === -1) return {}
  const title = plainText(lines[titleIndex]?.replace(/^#\s+/, "").replace(/\s+#+\s*$/, "") ?? "")
  let start = titleIndex + 1
  while (start < lines.length && !lines[start]?.trim()) start += 1
  const paragraph: string[] = []
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    // The lede is a paragraph: a heading, list, quote, table, fence, image, or HTML block ends it
    // before it starts. A list marker needs its space, so `**Bold**` still opens a paragraph.
    if (!line.trim()) break
    if (paragraph.length === 0 && /^\s*(#|>|\||```|~~~|[*+-]\s|\d+[.)]\s|!\[|<)/.test(line)) break
    // A hard line break, as two trailing spaces or a backslash, reads as a space.
    paragraph.push(line.trim().replace(/\\$/, ""))
  }
  const lede = plainText(paragraph.join(" "))
  return { ...(title ? { title } : {}), ...(lede ? { lede } : {}) }
}

/** Markdown inline syntax reduced to its words. */
function plainText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|~~|`)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!|~])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * The first rows of a table, read from the start of its text. The start can end inside a quoted
 * field and read as no table, though the file itself is fine.
 */
function tableStart(text: string, kind: "csv" | "tsv"): CsvTable | null {
  return parseTable(excerpt(text), kind)
}

function parseTable(text: string, kind: "csv" | "tsv"): CsvTable | null {
  try {
    const table = parseCsv(text, { delimiter: kind === "tsv" ? "\t" : "," })
    return table.header.length > 0 ? table : null
  } catch {
    return null
  }
}

/** The start of a text, cut at a line break so no half-read construct ends it. */
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

function fileFormat(
  name: string
): { readonly text: string; readonly className: string } | undefined {
  const extension = fileExtension(name)
  if (!extension) return undefined
  const color =
    FORMAT_COLORS.find(([pattern]) => pattern.test(extension))?.[1] ?? "bg-foreground/50"
  return { text: extension, className: color }
}
