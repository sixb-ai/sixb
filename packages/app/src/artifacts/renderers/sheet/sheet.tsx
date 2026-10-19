import {
  type CellRange,
  type CsvTable,
  parseSheetPart,
  type Workbook,
  type WorkbookChart,
} from "@sixb/core/artifacts"
import { Button } from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { Download, ListFilter, Search } from "lucide-react"
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"
import { useArtifactEditing, useReportDraft } from "../../edit-session"
import { formatFileSize } from "../../file-size"
import { type History, recordChange, redoChange, startHistory, undoChange } from "../../history"
import { useArtifactMessages } from "../../messages"
import { type ArtifactVersion, versionImageSource } from "../../queries"
import { useArtifactThemeAttributes } from "../../theme"
import { ViewerLoading, ViewerNotice } from "../notice"
import { CHART_ICONS } from "./chart-icon"
import { ColumnDialog, refusalText } from "./column-format"
import {
  type ColumnRefusal,
  cellEdited,
  deleteColumn,
  deleteRows,
  draftChanged,
  draftFiles,
  draftModel,
  draftSheet,
  draftTable,
  insertColumn,
  insertRows,
  setCells,
  setColumn,
  startDraft,
  type WorkbookDraft,
} from "./draft"
import { useSheetFind } from "./find-bar"
import {
  CommandBar,
  CommandButton,
  FindPanel,
  nameBoxRange,
  SheetBar,
  type SheetTabItem,
  StatusFigures,
} from "./frame"
import { SheetGrid, type SheetGridEditor, type SheetGridStatus } from "./grid"
import { cellInputText, parseCellInput } from "./input"
import type { SheetModel } from "./model"
import { rangeLabel } from "./selection"
import { INITIAL_SHEET_VIEW, type SheetView, setAutoFilter, useSheetViews } from "./view"
import { useSheetModel, useWorkbook } from "./workbook"

const SheetChart = lazy(() => import("./chart"))

type Tab =
  | { readonly kind: "sheet"; readonly name: string }
  | { readonly kind: "chart"; readonly name: string }

/**
 * A sheet artifact as a spreadsheet workbook: the formula bar with the name box and the active
 * cell's value, the grid with the sheet's charts beside it, and the sheet bar with a tab per sheet
 * and per chart and the status figures of the selection. `part` opens a sheet by name (`Summary`,
 * `Summary!A1:D5`) or a chart (`chart=revenue`).
 */
export function SheetRenderer({
  version,
  part,
}: {
  readonly version: ArtifactVersion
  readonly part?: string
}) {
  const messages = useArtifactMessages()
  const { workbook } = useWorkbook(version)
  const [chosen, setChosen] = useState<Tab | null>(() => tabFromPart(part))

  if (workbook === undefined) return <ViewerLoading label={messages.viewer.loading} />
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
  workbook: published,
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
  const id = useId()
  // A chart's sheet is its sheet in every draft: an edit renames columns, never sheets.
  const sheetName =
    (tab.kind === "chart"
      ? published.charts.find((entry) => entry.name === tab.name)?.sheet
      : undefined) ?? tab.name
  const read = useSheetModel(
    version,
    published.sheets.find((entry) => entry.name === sheetName)
  )
  const { source, loading, tooLarge } = read
  const edit = useWorkbookEdit(version, published, sheetName, read.table, read.model, locale)
  // What is shown is the draft's, while there is one: its charts follow a column renamed.
  const workbook = edit.workbook
  const chart =
    tab.kind === "chart" ? workbook.charts.find((entry) => entry.name === tab.name) : undefined
  const model = edit.model
  const [status, setStatus] = useState<SheetGridStatus | null>(null)
  const [goTo, setGoTo] = useState<{ range: CellRange; seq: number } | null>(null)
  const root = useRef<HTMLDivElement | null>(null)
  const finder = useSheetFind(root)
  const views = useSheetViews()
  const view = views.viewOf(sheetName)
  const updateView = views.updateOf(sheetName)
  const sheetCharts = workbook.charts.filter((entry) => entry.sheet === sheetName)
  const theme = useArtifactThemeAttributes(version)
  const tabs: readonly (Tab & SheetTabItem)[] = [
    ...workbook.sheets.map((entry) => ({
      kind: "sheet" as const,
      key: `sheet:${entry.name}`,
      name: entry.name,
      label: entry.name,
    })),
    ...workbook.charts.map((entry) => ({
      kind: "chart" as const,
      key: `chart:${entry.name}`,
      name: entry.name,
      label: (
        <>
          <ChartIcon type={entry.type} />
          <span className="max-w-56 truncate">{entry.title ?? entry.name}</span>
        </>
      ),
    })),
  ]
  const current = tabs.findIndex((entry) => entry.kind === tab.kind && entry.name === tab.name)
  const tabId = (index: number) => `${id}-tab-${index}`
  const panelId = `${id}-panel`
  const onSheet = tab.kind === "sheet" && model

  return (
    <div
      ref={root}
      data-sixb-artifact=""
      onKeyDown={tab.kind === "sheet" ? finder.onKeyDown : undefined}
      className={cn(
        "@container flex min-h-0 flex-1 flex-col bg-background text-foreground",
        theme.className
      )}
      style={theme.style}
    >
      <CommandBar
        // A chart's tab names the chart in the name box, as a spreadsheet names a selected chart.
        address={chart ? chart.name : onSheet && status ? rangeLabel(status.range) : ""}
        value={chart ? (chart.title ?? chart.name) : onSheet ? status?.value : null}
        {...(onSheet
          ? {
              onGoTo: (text: string) => {
                const range = nameBoxRange(text)
                if (range) setGoTo((current) => ({ range, seq: (current?.seq ?? 0) + 1 }))
                return !!range
              },
            }
          : {})}
        tools={
          onSheet ? (
            <>
              <CommandButton
                label={messages.sheet.find}
                icon={<Search aria-hidden="true" />}
                pressed={finder.open}
                onClick={finder.open ? finder.close : finder.show}
              />
              <CommandButton
                label={messages.sheet.filterMode}
                icon={<ListFilter aria-hidden="true" />}
                pressed={view.autoFilter}
                onClick={() => updateView((current) => setAutoFilter(current, !current.autoFilter))}
                showLabel
              />
            </>
          ) : null
        }
      />

      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(current)}
        className="relative flex min-h-0 flex-1"
      >
        {tab.kind === "sheet" ? <FindPanel finder={finder} /> : null}
        {!model ? (
          loading ? (
            <ViewerLoading label={messages.viewer.loading} />
          ) : tooLarge && source ? (
            <ViewerNotice
              title={messages.sheet.tooLarge}
              description={formatFileSize(source.fileRef.sizeBytes, locale, messages.files)}
              action={
                <Button size="sm" asChild>
                  <a href={source.downloadUrl} download={`${sheetName}.csv`}>
                    <Download />
                    {messages.sheet.downloadCsv(sheetName)}
                  </a>
                </Button>
              }
            />
          ) : (
            <ViewerNotice title={messages.sheet.loadFailed} />
          )
        ) : chart ? (
          <ChartPanel chart={chart} model={model} locale={locale} sheet={sheetName} large />
        ) : (
          <>
            <SheetGrid
              key={`${version.artifactId}@${version.version}:${sheetName}`}
              {...(selected ? { selected } : {})}
              {...(goTo ? { goTo } : {})}
              model={model}
              locale={locale}
              onStatusChange={setStatus}
              find={finder.find}
              onFind={finder.onFound}
              view={view}
              onViewChange={updateView}
              imageUrl={(path) => versionImageSource(version, path)?.inlineUrl}
              {...(edit.editor ? { editor: edit.editor } : {})}
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

      <SheetBar
        tabs={{
          items: tabs,
          current,
          onSelect: (index) => {
            const target = tabs[index]
            if (target) onTab({ kind: target.kind, name: target.name })
          },
          tabId,
          panelId,
        }}
        status={
          model ? (
            <StatusFigures
              model={model}
              status={tab.kind === "sheet" ? status : null}
              view={tab.kind === "sheet" ? view : INITIAL_SHEET_VIEW}
              onViewChange={updateView}
              locale={locale}
              messages={messages}
            />
          ) : null
        }
      />
      {edit.dialog}
    </div>
  )
}

/**
 * The workbook as the reader edits it, while the viewer is editing: the draft of every sheet
 * changed, the shown sheet's model drawn from it, the grid's editor, and the draft reported to
 * the header's Save. Leaving editing drops the draft.
 */
function useWorkbookEdit(
  version: ArtifactVersion,
  workbook: Workbook,
  sheetName: string,
  table: CsvTable | null,
  base: SheetModel | null,
  locale: string
): {
  readonly workbook: Workbook
  readonly model: SheetModel | null
  readonly editor: SheetGridEditor | null
  /** The column settings dialog, while one is open. */
  readonly dialog: ReactNode
} {
  const editing = useArtifactEditing()
  const [history, setHistory] = useState<History<WorkbookDraft>>(() =>
    startHistory(startDraft(workbook))
  )
  useEffect(() => {
    if (!editing) setHistory(startHistory(startDraft(workbook)))
  }, [editing, workbook])
  const draft = history.present
  /** One change of the draft: one step for undo. */
  const change = useCallback(
    (apply: (draft: WorkbookDraft) => WorkbookDraft) =>
      setHistory((last) => recordChange(last, apply(last.present))),
    []
  )
  const published = workbook.sheets.find((entry) => entry.name === sheetName)
  const layout = draftSheet(draft, sheetName)
  const current = table ? draftTable(draft, sheetName, table) : null
  const model = useMemo(
    () =>
      layout && base && current && (current !== table || layout !== published)
        ? draftModel(layout, current, base)
        : base,
    [layout, published, base, current, table]
  )
  /** The column whose settings are open, and what they open on. */
  const [settings, setSettings] = useState<{ column: number; focus: "name" | "type" } | null>(null)
  const messages = useArtifactMessages()
  const present = useRef(draft)
  present.current = draft
  /** A change that may be refused: made when it can be, its refusal returned when not. */
  const attempt = useCallback(
    (apply: (draft: WorkbookDraft) => WorkbookDraft | ColumnRefusal): ColumnRefusal | null => {
      const next = apply(present.current)
      if ("refused" in next) return next
      setHistory((last) => recordChange(last, next))
      return null
    },
    []
  )
  const editor = useMemo<SheetGridEditor | null>(() => {
    if (!editing || !model || !table || !current) return null
    const format = (column: number) => model.columns[column]?.format ?? { type: "text" as const }
    const images = new Set(version.files.map((file) => file.path))
    return {
      editable: (column) => !format(column).formula,
      inputText: (column, raw) => cellInputText(raw, format(column), locale),
      read: (column, text, pasted) =>
        parseCellInput(text, format(column), locale, {
          image: (path) => images.has(path.replace(/^\.\//, "")),
          pasted: pasted ?? false,
        }),
      write: (edits, grow) => change((last) => setCells(last, sheetName, table, edits, grow)),
      insertRows: (at, count) => change((last) => insertRows(last, sheetName, table, at, count)),
      deleteRows: (rows) => change((last) => deleteRows(last, sheetName, table, rows)),
      insertColumn: (at) => change((last) => insertColumn(last, sheetName, table, at)),
      deleteColumn: (column) => {
        const refused = attempt((last) => deleteColumn(last, sheetName, table, column))
        return refused ? refusalText(refused, messages.column, () => "") : null
      },
      editColumn: (column, focus) => setSettings({ column, focus }),
      undo: () => setHistory(undoChange),
      redo: () => setHistory(redoChange),
      edited: (row, column) => cellEdited(current, row, column),
      suggestions: (column) => tagSuggestions(model, column),
    }
  }, [editing, model, table, current, version.files, locale, sheetName, change, attempt, messages])
  const canUndo = history.past.length > 0
  const canRedo = history.future.length > 0
  const report = useMemo(
    () =>
      editing
        ? {
            changed: draftChanged(draft),
            files: () => draftFiles(draft),
            ...(canUndo ? { undo: () => setHistory(undoChange) } : {}),
            ...(canRedo ? { redo: () => setHistory(redoChange) } : {}),
          }
        : null,
    [editing, draft, canUndo, canRedo]
  )
  useReportDraft(report)

  const column = settings && model && layout ? model.columns[settings.column] : undefined
  const dialog =
    editing && settings && column && layout && table ? (
      <ColumnDialog
        key={`${settings.column}:${column.name}`}
        subject={{
          name: column.name,
          format: column.format,
          ...(column.description ? { description: column.description } : {}),
          ...(column.total ? { total: column.total } : {}),
          others: new Map(
            model?.columns
              .filter((entry) => entry.name !== column.name)
              .map((entry) => [entry.name, entry.format.type])
          ),
        }}
        focus={settings.focus}
        onApply={(next) =>
          attempt((last) =>
            setColumn(last, sheetName, table, settings.column, next, (value, format) =>
              parseCellInput(value, format, locale, { pasted: true })
            )
          )
        }
        onClose={() => setSettings(null)}
      />
    ) : null
  return { workbook: editing ? draft.workbook : workbook, model, editor, dialog }
}

/** A tag column's tags to offer while typing: its toned tags, then the values it holds. */
function tagSuggestions(model: SheetModel, column: number): readonly string[] {
  const entry = model.columns[column]
  if (entry?.format.type !== "tag") return []
  const tags = new Set(Object.keys(entry.format.tones ?? {}))
  for (const row of model.rows) {
    const value = row[column]?.trim()
    if (value) tags.add(value)
    if (tags.size >= 50) break
  }
  return [...tags]
}

/** One table on its own, as a CSV file shows: the command bar, the grid, and the status bar. */
export function SheetTable({ model }: { readonly model: SheetModel }) {
  const messages = useArtifactMessages()
  const locale = useLocale()
  const [status, setStatus] = useState<SheetGridStatus | null>(null)
  const [goTo, setGoTo] = useState<{ range: CellRange; seq: number } | null>(null)
  const root = useRef<HTMLDivElement | null>(null)
  const finder = useSheetFind(root)
  const [view, setView] = useState<SheetView>(INITIAL_SHEET_VIEW)
  return (
    <div
      ref={root}
      onKeyDown={finder.onKeyDown}
      className="@container flex min-h-0 flex-1 flex-col bg-background"
    >
      <CommandBar
        address={status ? rangeLabel(status.range) : ""}
        value={status?.value}
        onGoTo={(text) => {
          const range = nameBoxRange(text)
          if (range) setGoTo((current) => ({ range, seq: (current?.seq ?? 0) + 1 }))
          return !!range
        }}
        tools={
          <>
            <CommandButton
              label={messages.sheet.find}
              icon={<Search aria-hidden="true" />}
              pressed={finder.open}
              onClick={finder.open ? finder.close : finder.show}
            />
            <CommandButton
              label={messages.sheet.filterMode}
              icon={<ListFilter aria-hidden="true" />}
              pressed={view.autoFilter}
              onClick={() => setView((current) => setAutoFilter(current, !current.autoFilter))}
              showLabel
            />
          </>
        }
      />
      <div className="relative flex min-h-0 flex-1">
        <FindPanel finder={finder} />
        <SheetGrid
          model={model}
          locale={locale}
          onStatusChange={setStatus}
          find={finder.find}
          onFind={finder.onFound}
          view={view}
          onViewChange={setView}
          {...(goTo ? { goTo } : {})}
          className="flex-1"
        />
      </div>
      <SheetBar
        status={
          <StatusFigures
            model={model}
            status={status}
            view={view}
            onViewChange={setView}
            locale={locale}
            messages={messages}
          />
        }
      />
    </div>
  )
}

function ChartIcon({ type }: { readonly type: WorkbookChart["type"] }) {
  const Icon = CHART_ICONS[type]
  return <Icon className="size-3.5" aria-hidden="true" />
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
