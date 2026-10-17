import {
  type CellRange,
  parseCsv,
  parseSheetPart,
  parseWorkbook,
  sheetFilePath,
  WORKBOOK_FILE,
  type Workbook,
  type WorkbookChart,
} from "@sixb/core/artifacts"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { AreaChart as AreaIcon, ChartColumn, ChartLine, ChartPie, Download } from "lucide-react"
import { lazy, type ReactNode, Suspense, useMemo, useState } from "react"
import { type ArtifactMessages, useArtifactMessages } from "../../messages"
import {
  type ArtifactVersion,
  useArtifactTheme,
  useFileText,
  versionFileSource,
  versionImageSource,
} from "../../queries"
import { artifactThemeAttributes } from "../../theme"
import { ViewerLoading, ViewerNotice } from "../notice"
import { cellFormatter } from "./format"
import { SheetGrid, type SheetGridStatus } from "./grid"
import { type SheetColumn, type SheetModel, sheetModel } from "./model"
import { rangeLabel } from "./selection"

const SheetChart = lazy(() => import("./chart"))

type Tab =
  | { readonly kind: "sheet"; readonly name: string }
  | { readonly kind: "chart"; readonly name: string }

/**
 * A sheet artifact as a spreadsheet: a tab per sheet and per chart, a name box with the selection
 * and its column's type, the grid with the sheet's charts beside it, and a status bar that sums
 * what is selected. `part` opens a sheet by name (`Summary`, `Summary!A1:D5`) or a chart
 * (`chart=revenue`).
 */
export function SheetRenderer({
  version,
  part,
}: {
  readonly version: ArtifactVersion
  readonly part?: string
}) {
  const messages = useArtifactMessages()
  const workbookFile = useFileText(versionFileSource(version, WORKBOOK_FILE))
  const workbook = useMemo(() => {
    if (workbookFile.text === undefined) return undefined
    const parsed = parseWorkbook(workbookFile.text)
    return "workbook" in parsed ? parsed.workbook : null
  }, [workbookFile.text])
  const [chosen, setChosen] = useState<Tab | null>(() => tabFromPart(part))

  if (workbookFile.loading || workbook === undefined) {
    return workbookFile.error ? (
      <ViewerNotice title={messages.sheet.loadFailed} />
    ) : (
      <ViewerLoading label={messages.viewer.loading} />
    )
  }
  if (!workbook) return <ViewerNotice title={messages.sheet.loadFailed} />
  const tab = validTab(workbook, chosen)
  if (!tab) return <ViewerNotice title={messages.sheet.empty} />
  // A range the address named opens selected, on its own sheet only.
  const named = part ? parseSheetPart(part) : null
  const selected =
    named?.type === "sheet" && named.range && tab.kind === "sheet" && tab.name === named.sheet
      ? named.range
      : undefined
  return (
    <WorkbookView
      version={version}
      workbook={workbook}
      tab={tab}
      onTab={setChosen}
      {...(selected ? { selected } : {})}
    />
  )
}

function WorkbookView({
  version,
  workbook,
  tab,
  onTab,
  selected,
}: {
  readonly version: ArtifactVersion
  readonly workbook: Workbook
  readonly tab: Tab
  readonly onTab: (tab: Tab) => void
  readonly selected?: CellRange
}) {
  const messages = useArtifactMessages()
  const locale = useLocale()
  const chart =
    tab.kind === "chart" ? workbook.charts.find((entry) => entry.name === tab.name) : undefined
  const sheetName = chart?.sheet ?? tab.name
  const sheet = workbook.sheets.find((entry) => entry.name === sheetName)
  const source = versionFileSource(version, sheetFilePath(sheetName))
  const csv = useFileText(source)
  const model = useMemo(() => {
    if (!sheet || csv.text === undefined) return null
    try {
      return sheetModel(sheet, parseCsv(csv.text))
    } catch {
      return null
    }
  }, [sheet, csv.text])
  const [status, setStatus] = useState<SheetGridStatus | null>(null)
  const sheetCharts = workbook.charts.filter((entry) => entry.sheet === sheetName)
  const theme = artifactThemeAttributes(useArtifactTheme(version))

  return (
    <div
      data-sixb-artifact=""
      className={cn(
        "@container flex min-h-0 flex-1 flex-col bg-background text-foreground",
        theme.className
      )}
      style={theme.style}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/70 pr-3">
        <div
          role="tablist"
          aria-label={messages.sheet.tabs}
          className="flex h-full min-w-0 flex-1 items-end gap-0.5 overflow-x-auto px-3 [scrollbar-width:none]"
        >
          {workbook.sheets.map((entry) => (
            <TabButton
              key={`sheet:${entry.name}`}
              selected={tab.kind === "sheet" && tab.name === entry.name}
              onSelect={() => onTab({ kind: "sheet", name: entry.name })}
            >
              {entry.name}
            </TabButton>
          ))}
          {workbook.charts.map((entry) => (
            <TabButton
              key={`chart:${entry.name}`}
              selected={tab.kind === "chart" && tab.name === entry.name}
              onSelect={() => onTab({ kind: "chart", name: entry.name })}
            >
              <ChartIcon type={entry.type} />
              <span className="max-w-56 truncate">{entry.title ?? entry.name}</span>
            </TabButton>
          ))}
        </div>
        {source ? (
          <a
            href={source.downloadUrl}
            download={`${sheetName}.csv`}
            aria-label={messages.sheet.downloadCsv(sheetName)}
            title={messages.sheet.downloadCsv(sheetName)}
            className="flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            <Download className="size-3.5" aria-hidden="true" />
            {messages.sheet.csv}
          </a>
        ) : null}
      </div>

      {tab.kind === "sheet" ? <NameBox status={status} messages={messages} /> : null}

      <div className="flex min-h-0 flex-1">
        {!model ? (
          csv.loading ? (
            <ViewerLoading label={messages.viewer.loading} />
          ) : (
            <ViewerNotice title={messages.sheet.loadFailed} />
          )
        ) : chart ? (
          <ChartPanel chart={chart} model={model} locale={locale} sheet={sheetName} large />
        ) : (
          <>
            <SheetGrid
              key={`${version.version}:${sheetName}`}
              {...(selected ? { selected } : {})}
              model={model}
              locale={locale}
              onStatusChange={setStatus}
              imageUrl={(path) => versionImageSource(version, path)?.inlineUrl}
              className="flex-1"
            />
            {sheetCharts.length > 0 ? (
              <aside className="hidden w-[360px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-border/70 bg-muted/20 p-3 @4xl:flex">
                {sheetCharts.map((entry) => (
                  <div
                    key={entry.name}
                    className="rounded-xl border border-border/70 bg-background p-3 shadow-[0_1px_2px_rgb(0_0_0/0.04)]"
                  >
                    <ChartPanel
                      chart={entry}
                      model={model}
                      locale={locale}
                      sheet={sheetName}
                      onOpen={() => onTab({ kind: "chart", name: entry.name })}
                    />
                  </div>
                ))}
              </aside>
            ) : null}
          </>
        )}
      </div>

      <StatusBar
        model={model}
        status={tab.kind === "sheet" ? status : null}
        locale={locale}
        messages={messages}
      />
    </div>
  )
}

/** One table on its own, as a CSV file shows: the name box, the grid, and the status bar. */
export function SheetTable({ model }: { readonly model: SheetModel }) {
  const messages = useArtifactMessages()
  const locale = useLocale()
  const [status, setStatus] = useState<SheetGridStatus | null>(null)
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <NameBox status={status} messages={messages} />
      <SheetGrid model={model} locale={locale} onStatusChange={setStatus} className="flex-1" />
      <StatusBar model={model} status={status} locale={locale} messages={messages} />
    </div>
  )
}

function TabButton({
  selected,
  onSelect,
  children,
}: {
  readonly selected: boolean
  readonly onSelect: () => void
  readonly children: ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "flex h-11 shrink-0 items-center gap-1.5 px-3 text-[13px] whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        selected
          ? "font-medium text-foreground shadow-[inset_0_-2px_0_var(--foreground)]"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  )
}

function ChartIcon({ type }: { readonly type: WorkbookChart["type"] }) {
  const Icon =
    type === "line"
      ? ChartLine
      : type === "area"
        ? AreaIcon
        : type === "pie"
          ? ChartPie
          : ChartColumn
  return <Icon className="size-3.5" aria-hidden="true" />
}

/** The selection's address, its column's name, and what type the column holds. */
function NameBox({
  status,
  messages,
}: {
  readonly status: SheetGridStatus | null
  readonly messages: ArtifactMessages
}) {
  const column = status?.column
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 overflow-hidden border-b border-border/70 px-3 text-[13px]">
      <span className="flex h-6 min-w-14 items-center justify-center rounded-md border border-border px-2 font-mono text-xs tabular-nums">
        {status ? rangeLabel(status.range) : "A1"}
      </span>
      {column ? (
        <>
          <span className="truncate font-medium">{column.name}</span>
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {typeLabel(column, messages)}
          </span>
        </>
      ) : null}
    </div>
  )
}

function typeLabel(column: SheetColumn, messages: ArtifactMessages): string {
  const types = messages.sheet.types
  return column.format.type === "currency"
    ? types.currency(column.format.currency ?? "USD")
    : types[column.format.type]
}

function StatusBar({
  model,
  status,
  locale,
  messages,
}: {
  readonly model: SheetModel | null
  readonly status: SheetGridStatus | null
  readonly locale: string
  readonly messages: ArtifactMessages
}) {
  if (!model) return null
  const stats = status?.stats
  // One numeric column reads in its own format; a wider selection as plain numbers.
  const single = status && status.range.left === status.range.right ? status.column : undefined
  const format = (value: number) =>
    single?.numeric
      ? cellFormatter(single, locale)(String(value)).text
      : value.toLocaleString(locale, { maximumFractionDigits: 2 })
  return (
    <div className="flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-border/70 px-4 py-1.5 text-xs text-muted-foreground tabular-nums">
      <span>
        {model.name} · {messages.sheet.rows(model.rows.length)}
        {model.frozenRows > 0 ? ` · ${messages.sheet.frozenRows(model.frozenRows)}` : ""}
      </span>
      {stats && stats.count > 1 ? (
        <span className="flex flex-wrap gap-4">
          {stats.numericCount > 0 ? (
            <>
              <Stat label={messages.sheet.sum} value={format(stats.sum)} />
              {stats.average !== undefined ? (
                <Stat label={messages.sheet.average} value={format(stats.average)} />
              ) : null}
            </>
          ) : null}
          <Stat label={messages.sheet.count} value={stats.count.toLocaleString(locale)} />
        </span>
      ) : null}
    </div>
  )
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <span>
      {label} <strong className="font-semibold text-foreground">{value}</strong>
    </span>
  )
}

function ChartPanel({
  chart,
  model,
  locale,
  sheet,
  large = false,
  onOpen,
}: {
  readonly chart: WorkbookChart
  readonly model: SheetModel
  readonly locale: string
  readonly sheet: string
  readonly large?: boolean
  /** Opens the chart in its own tab; a chart beside the grid has it. */
  readonly onOpen?: () => void
}) {
  const messages = useArtifactMessages().sheet
  return (
    <figure
      className={cn(
        "m-0 flex min-w-0 flex-col gap-3",
        large ? "mx-auto h-full w-full max-w-5xl p-6 @lg:p-10" : "w-full"
      )}
    >
      <figcaption className="flex items-baseline justify-between gap-3">
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="min-w-0 truncate rounded-sm text-left text-[13px] font-semibold text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {chart.title ?? chart.name}
          </button>
        ) : (
          <span
            className={cn("font-semibold text-foreground", large ? "text-base" : "text-[13px]")}
          >
            {chart.title ?? chart.name}
          </span>
        )}
        <span className="shrink-0 text-xs text-muted-foreground">
          {messages.chartOf(messages.charts[chart.type], sheet)}
        </span>
      </figcaption>
      <div
        className={
          large ? "min-h-[320px] flex-1" : chart.type === "pie" ? "h-[300px]" : "h-[200px]"
        }
      >
        <Suspense fallback={<div className="h-full animate-pulse rounded-lg bg-muted/60" />}>
          <SheetChart chart={chart} model={model} locale={locale} />
        </Suspense>
      </div>
    </figure>
  )
}

function tabFromPart(part: string | undefined): Tab | null {
  if (!part) return null
  if (part.startsWith("chart=")) return { kind: "chart", name: part.slice("chart=".length) }
  return { kind: "sheet", name: part.split("!")[0] ?? part }
}

/** The tab asked for, when the workbook has it; else its first sheet. */
function validTab(workbook: Workbook, tab: Tab | null): Tab | null {
  if (tab?.kind === "chart" && workbook.charts.some((chart) => chart.name === tab.name)) return tab
  if (tab?.kind === "sheet" && workbook.sheets.some((sheet) => sheet.name === tab.name)) return tab
  const first = workbook.sheets[0]
  return first ? { kind: "sheet", name: first.name } : null
}
