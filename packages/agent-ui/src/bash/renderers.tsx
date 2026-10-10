import { MiniSparkline } from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { formatRelativeTime } from "../format"
import { useAgentMessages } from "../i18n"
import {
  arrayLen,
  extractObjects,
  formatValue,
  metaLine,
  namedItems,
  numberField,
  numberOr,
  pickColumns,
  runTiming,
  type SeriesPoint,
  seriesUnit,
  singleObject,
  stringField,
  toSeriesData,
} from "./data"
import {
  capitalize,
  commandPreview,
  humanize,
  isRecord,
  type ParsedBashOutput,
  runStatus,
  subjectLabel,
} from "./interpret"

// Each renderer takes the already-parsed bash output and renders the decoded `json` natively, with
// the lightest possible chrome — no nested boxes, no badge pills. Anything a renderer doesn't
// recognize falls through to the neutral data view, never to raw JSON in the reading path. The pure
// shaping (rows, columns, series, labels) lives in `./data`; this file owns only the JSX.

const MAX_ROWS = 50

interface CommandViewProps {
  readonly parsed: ParsedBashOutput
}

/** `sixb ontology list` — a calm two-column list of the live ontology. */
export function ObjectTypesView({ parsed }: CommandViewProps) {
  const counts = useAgentMessages().bash.counts
  const types = Array.isArray(parsed.json) ? parsed.json.filter(isRecord) : null
  if (!types) return <StructuredDataView parsed={parsed} />

  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
      {types.map((type, index) => (
        <div key={stringField(type, "id") ?? index}>
          <p className="font-medium text-foreground">
            {stringField(type, "name") ?? stringField(type, "id")}
          </p>
          {stringField(type, "description") ? (
            <p className="text-muted-foreground">{stringField(type, "description")}</p>
          ) : null}
          <p className="mt-0.5 text-[11px] text-muted-foreground/60">
            {metaLine([
              [arrayLen(type.properties), counts.properties],
              [arrayLen(type.links), counts.links],
              [arrayLen(type.actions), counts.actions],
            ])}
          </p>
        </div>
      ))}
    </div>
  )
}

/** Sixb object list, lookup, search, and query results — a clean, separator-only table. */
export function ObjectListView({ parsed }: CommandViewProps) {
  const messages = useAgentMessages().results
  const objects = extractObjects(parsed.json)
  if (!objects) return <StructuredDataView parsed={parsed} />
  if (objects.length === 0) return <Empty message={messages.noMatchingObjects} />

  const columns = pickColumns(objects)
  const rows = objects.slice(0, MAX_ROWS)
  const total = numberField(parsed.json, "total")
  const hasMore = isRecord(parsed.json) && parsed.json.hasMore === true

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
              <Th>ID</Th>
              {columns.map((column) => (
                <Th key={column}>{humanize(column) || column}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((object, index) => {
              const properties = isRecord(object.properties) ? object.properties : {}
              return (
                <tr
                  key={stringField(object, "primaryId") ?? index}
                  className="border-t border-border/40"
                >
                  <Td className="font-medium text-foreground">
                    {stringField(object, "primaryId") ?? "—"}
                  </Td>
                  {columns.map((column) => (
                    <Td key={column} className="text-muted-foreground">
                      <CellValue value={properties[column]} />
                    </Td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <ResultFooter shown={rows.length} total={total} hasMore={hasMore} />
    </div>
  )
}

/** `sixb objects inspect` — a property sheet for the root object. */
export function ObjectDetailView({ parsed }: CommandViewProps) {
  const object = singleObject(parsed.json)
  if (!object) return <StructuredDataView parsed={parsed} />

  const properties = isRecord(object.properties) ? object.properties : object
  const entries = Object.entries(properties).filter(([key]) => key !== "properties")

  return (
    <PropertySheet
      title={stringField(object, "primaryId")}
      entries={entries.map(([key, value]) => [humanize(key) || key, value])}
    />
  )
}

/** `sixb objects facets` — a compact proportional breakdown. */
export function FacetsView({ parsed }: CommandViewProps) {
  const messages = useAgentMessages()
  const facets =
    isRecord(parsed.json) && Array.isArray(parsed.json.facets) ? parsed.json.facets : null
  if (!facets) return <StructuredDataView parsed={parsed} />

  const populated = facets.filter(
    (facet): facet is Record<string, unknown> =>
      isRecord(facet) && Array.isArray(facet.buckets) && facet.buckets.length > 0
  )
  if (populated.length === 0) return <Empty message={messages.results.noBreakdown} />

  return (
    <div className="space-y-3">
      {populated.map((facet, index) => {
        const buckets = (facet.buckets as unknown[]).filter(isRecord)
        const max = Math.max(...buckets.map((bucket) => numberOr(bucket.count, 0)), 1)
        return (
          <div key={stringField(facet, "propertyId") ?? index}>
            <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
              {humanize(stringField(facet, "propertyId")) || messages.results.value}
            </p>
            <div className="space-y-1">
              {buckets.map((bucket, bucketIndex) => {
                const value = numberOr(bucket.count, 0)
                return (
                  <div key={bucketIndex} className="flex items-center gap-2">
                    <span className="w-28 shrink-0 truncate text-foreground">
                      {formatValue(bucket.value, messages.bash)}
                    </span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-foreground/30"
                        style={{ width: `${(value / max) * 100}%` }}
                      />
                    </span>
                    <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
                      {messages.bash.number(value)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** `sixb telemetry history` — latest value plus a clean sparkline. */
export function TelemetryHistoryView({ parsed }: CommandViewProps) {
  const messages = useAgentMessages().results
  const data = toSeriesData(parsed.json)
  if (data.length === 0) return <Empty message={messages.noReadings} />
  return <SeriesChart data={data} unit={seriesUnit(parsed.json)} />
}

/** `sixb telemetry query` — one labeled sparkline per series. */
export function TelemetryBulkView({ parsed }: CommandViewProps) {
  const messages = useAgentMessages().results
  const series =
    isRecord(parsed.json) && Array.isArray(parsed.json.series)
      ? parsed.json.series.filter(isRecord)
      : null
  if (!series || series.length === 0) return <Empty message={messages.noSeries} />

  return (
    <div className="space-y-4">
      {series.map((entry, index) => {
        const data = toSeriesData(entry.points)
        const label = [stringField(entry, "objectId"), humanize(stringField(entry, "propertyId"))]
          .filter(Boolean)
          .join(" · ")
        return (
          <div key={index}>
            <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
              {label || messages.series(index + 1)}
            </p>
            {data.length > 0 ? (
              <SeriesChart data={data} unit={seriesUnit(entry.points)} />
            ) : (
              <Empty message={messages.noReadings} />
            )}
          </div>
        )
      })}
    </div>
  )
}

/** `sixb ontology get` — a single type's schema, in plain labeled sections. */
export function ObjectTypeSchemaView({ parsed }: CommandViewProps) {
  const messages = useAgentMessages().results
  const type = isRecord(parsed.json) ? parsed.json : null
  if (!type) return <StructuredDataView parsed={parsed} />

  return (
    <div className="space-y-3">
      {stringField(type, "description") ? (
        <p className="text-muted-foreground">{stringField(type, "description")}</p>
      ) : null}
      <SchemaSection label={messages.properties} items={namedItems(type.properties)} />
      <SchemaSection label={messages.links} items={namedItems(type.links)} />
      <SchemaSection label={messages.actions} items={namedItems(type.actions)} />
    </div>
  )
}

/** `sixb actions request` — a calm confirmation that a run was requested. */
export function ActionResultView({ parsed }: CommandViewProps) {
  const agentMessages = useAgentMessages()
  const messages = agentMessages.results
  const locale = useLocale()
  const result = isRecord(parsed.json) ? parsed.json : null
  const runId = result && typeof result.runId === "string" ? result.runId : null
  if (!runId) return <StructuredDataView parsed={parsed} />

  const created = result?.created !== false
  const queuedAt = typeof result?.queuedAt === "string" ? result.queuedAt : undefined

  return (
    <div className="space-y-1">
      <p className="text-foreground">
        {created ? messages.actionRequested : messages.actionInProgress}
      </p>
      <p className="text-[11px] text-muted-foreground/60">
        {messages.run} <span className="font-mono text-muted-foreground">{runId}</span>
        {queuedAt
          ? ` · ${messages.queuedAgo(formatRelativeTime(queuedAt, locale, agentMessages.time))}`
          : ""}
      </p>
    </div>
  )
}

const STATUS_DOT: Record<string, string> = {
  succeeded: "bg-emerald-500",
  failed: "bg-destructive",
  running: "bg-amber-400 animate-pulse",
  queued: "bg-muted-foreground/50",
  cancelled: "bg-muted-foreground/40",
}

/** `sixb action-runs get` — the run's status, timing, and any error. */
export function ActionRunView({ parsed }: CommandViewProps) {
  const messages = useAgentMessages()
  const locale = useLocale()
  const run = isRecord(parsed.json) ? parsed.json : null
  if (!run) return <StructuredDataView parsed={parsed} />

  const status = stringField(run, "status") ?? "queued"
  const subject = subjectLabel(run.subject)
  const error = isRecord(run.error) ? run.error : null
  const params = isRecord(run.params) ? Object.entries(run.params) : []

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span
          className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[status] ?? STATUS_DOT.queued)}
        />
        <span className="font-medium text-foreground">
          {capitalize(runStatus({ status }, messages.bash) ?? status)}
        </span>
        {subject ? (
          <span className="text-muted-foreground/60">{messages.results.onSubject(subject)}</span>
        ) : null}
        <span className="ml-auto text-[11px] text-muted-foreground/60">
          {runTiming(run, messages, locale)}
        </span>
      </div>

      {error ? (
        <p className="border-l-2 border-destructive/30 pl-3 text-destructive whitespace-pre-wrap">
          {stringField(error, "message") ?? messages.results.actionFailed}
        </p>
      ) : null}

      {params.length > 0 ? (
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
            {messages.results.inputs}
          </p>
          <PropertySheet entries={params.map(([key, value]) => [humanize(key) || key, value])} />
        </div>
      ) : null}
    </div>
  )
}

/** A plain shell command — clean monospace output, no JSON envelope, no border. */
export function GenericCommandView({
  parsed,
  command,
}: CommandViewProps & { readonly command?: string }) {
  const messages = useAgentMessages()
  return (
    <div className="space-y-2">
      {command ? (
        <pre className="overflow-x-auto rounded bg-muted/50 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
          <span className="select-none text-muted-foreground/50">$ </span>
          {commandPreview(command, undefined, messages)}
        </pre>
      ) : null}
      {parsed.stdout.trim() ? (
        <pre className="scrollbar-thin max-h-72 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground">
          {parsed.stdout}
        </pre>
      ) : (
        <Empty message={messages.results.noOutput} />
      )}
      {parsed.stderr.trim() ? (
        <pre className="scrollbar-thin max-h-40 overflow-auto rounded px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-destructive">
          {parsed.stderr}
        </pre>
      ) : null}
      {parsed.truncated ? (
        <p className="text-[11px] text-muted-foreground/60">{messages.results.outputTruncated}</p>
      ) : null}
    </div>
  )
}

/**
 * Neutral fallback for parsed CLI results without a dedicated renderer. Arrays become a simple
 * list, objects a property sheet of their scalar fields. Never prints raw JSON in the reading path.
 */
export function StructuredDataView({ parsed }: CommandViewProps) {
  const messages = useAgentMessages().results
  const json = parsed.json

  if (Array.isArray(json)) {
    const items = json.filter(isRecord)
    if (items.length === 0) return <Empty message={messages.noItems} />
    return (
      <ul className="space-y-1.5">
        {items.slice(0, MAX_ROWS).map((item, index) => (
          <li key={index}>
            <span className="font-medium text-foreground">
              {stringField(item, "name") ?? stringField(item, "id") ?? messages.item(index + 1)}
            </span>
            {stringField(item, "description") ? (
              <span className="ml-2 text-muted-foreground">{stringField(item, "description")}</span>
            ) : null}
          </li>
        ))}
      </ul>
    )
  }

  if (isRecord(json)) {
    const entries = Object.entries(json).filter(
      ([, value]) => !isRecord(value) && !Array.isArray(value)
    )
    if (entries.length > 0) {
      return (
        <PropertySheet entries={entries.map(([key, value]) => [humanize(key) || key, value])} />
      )
    }
  }

  // Last resort: the decoded output as plain text, not an escaped JSON string.
  return <GenericCommandView parsed={parsed} />
}

// --- Shared pieces ---------------------------------------------------------

function PropertySheet({
  title,
  entries,
}: {
  title?: string
  entries: ReadonlyArray<readonly [string, unknown]>
}) {
  return (
    <div className="space-y-2">
      {title ? <p className="font-medium text-foreground">{title}</p> : null}
      <dl className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
        {entries.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-0.5">
            <dt className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
              {label}
            </dt>
            <dd className="text-foreground">
              <CellValue value={value} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** Latest reading + min/max framing a single sparkline. */
function SeriesChart({ data, unit }: { data: readonly SeriesPoint[]; unit?: string }) {
  const messages = useAgentMessages()
  const locale = useLocale()
  const values = data.map((point) => point.value)
  const latest = data[data.length - 1]
  const min = Math.min(...values)
  const max = Math.max(...values)

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-semibold tabular-nums text-foreground">
          {messages.bash.number(latest.value)}
        </span>
        {unit ? <span className="text-muted-foreground">{unit}</span> : null}
        <span className="ml-auto text-[11px] text-muted-foreground/60">
          {formatRelativeTime(latest.timestamp, locale, messages.time)}
        </span>
      </div>
      <MiniSparkline data={[...data]} width={560} height={48} showDot className="h-12 w-full" />
      {min !== max ? (
        <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground/60">
          <span>{messages.results.low(messages.bash.number(min))}</span>
          <span>{messages.results.high(messages.bash.number(max))}</span>
        </div>
      ) : null}
    </div>
  )
}

function SchemaSection({
  label,
  items,
}: {
  label: string
  items: ReadonlyArray<{ name: string; meta?: string }>
}) {
  if (items.length === 0) return null
  return (
    <div>
      <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">{label}</p>
      <div className="flex flex-col gap-0.5">
        {items.map((item) => (
          <div key={item.name} className="flex items-baseline gap-2">
            <span className="text-foreground">{item.name}</span>
            {item.meta ? <span className="text-muted-foreground/60">{item.meta}</span> : null}
          </div>
        ))}
      </div>
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="py-1 pr-6 font-medium whitespace-nowrap last:pr-0">{children}</th>
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn("py-1.5 pr-6 whitespace-nowrap last:pr-0", className)}>{children}</td>
}

function ResultFooter({
  shown,
  total,
  hasMore,
}: {
  shown: number
  total: number | null
  hasMore: boolean
}) {
  const messages = useAgentMessages().results
  const label =
    total !== null && total > shown ? messages.showing(shown, total) : messages.results(shown)
  const suffix = hasMore && (total === null || total <= shown) ? ` · ${messages.moreAvailable}` : ""
  return <p className="mt-2 text-[11px] text-muted-foreground/60">{`${label}${suffix}`}</p>
}

function Empty({ message }: { message: string }) {
  return <p className="text-muted-foreground/70">{message}</p>
}

function CellValue({ value }: { value: unknown }) {
  const messages = useAgentMessages()
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground/40">—</span>
  }
  if (typeof value === "number")
    return <span className="tabular-nums">{messages.bash.number(value)}</span>
  if (typeof value === "boolean") return <span>{value ? messages.bash.yes : messages.bash.no}</span>
  if (typeof value === "string") return <span>{value}</span>
  if (Array.isArray(value))
    return <span className="text-muted-foreground/60">{messages.results.items(value.length)}</span>
  return <span className="text-muted-foreground/60">…</span>
}
