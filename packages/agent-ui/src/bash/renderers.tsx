import { MiniSparkline } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { formatRelativeTime } from "../format"
import { capitalize, humanize, isRecord, type ParsedBashOutput, subjectLabel } from "./interpret"

// Each renderer takes the already-parsed bash output and renders the decoded `json` natively, with
// the lightest possible chrome — no nested boxes, no badge pills. Anything a renderer doesn't
// recognize falls through to the neutral data view, never to raw JSON in the reading path.

const MAX_ROWS = 50
const MAX_COLUMNS = 5
// Property keys that just echo the row's identity — never worth a column of their own.
const REDUNDANT_KEYS = new Set(["id", "primaryId", "objectTypeId"])

interface ApiViewProps {
  readonly parsed: ParsedBashOutput
}

/** `GET /api/object-types` — a calm two-column list of the live ontology. */
export function ObjectTypesView({ parsed }: ApiViewProps) {
  const types = Array.isArray(parsed.json) ? parsed.json.filter(isRecord) : null
  if (!types) return <ApiDataView parsed={parsed} />

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
              [arrayLen(type.properties), "property", "properties"],
              [arrayLen(type.links), "link", "links"],
              [arrayLen(type.actions), "action", "actions"],
            ])}
          </p>
        </div>
      ))}
    </div>
  )
}

/** `GET /api/objects` and `POST /api/objects/query` — a clean, separator-only table. */
export function ObjectListView({ parsed }: ApiViewProps) {
  const objects = extractObjects(parsed.json)
  if (!objects) return <ApiDataView parsed={parsed} />
  if (objects.length === 0) return <Empty message="No matching objects." />

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

/** `GET /api/objects/:type/:id` — a property sheet for one object. */
export function ObjectDetailView({ parsed }: ApiViewProps) {
  const object = singleObject(parsed.json)
  if (!object) return <ApiDataView parsed={parsed} />

  const properties = isRecord(object.properties) ? object.properties : object
  const entries = Object.entries(properties).filter(([key]) => key !== "properties")

  return (
    <PropertySheet
      title={stringField(object, "primaryId")}
      entries={entries.map(([key, value]) => [humanize(key) || key, value])}
    />
  )
}

/** `POST /api/objects/query/facets` — a compact proportional breakdown. */
export function FacetsView({ parsed }: ApiViewProps) {
  const facets =
    isRecord(parsed.json) && Array.isArray(parsed.json.facets) ? parsed.json.facets : null
  if (!facets) return <ApiDataView parsed={parsed} />

  const populated = facets.filter(
    (facet): facet is Record<string, unknown> =>
      isRecord(facet) && Array.isArray(facet.buckets) && facet.buckets.length > 0
  )
  if (populated.length === 0) return <Empty message="No breakdown available." />

  return (
    <div className="space-y-3">
      {populated.map((facet, index) => {
        const buckets = (facet.buckets as unknown[]).filter(isRecord)
        const max = Math.max(...buckets.map((bucket) => numberOr(bucket.count, 0)), 1)
        return (
          <div key={stringField(facet, "propertyId") ?? index}>
            <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
              {humanize(stringField(facet, "propertyId")) || "value"}
            </p>
            <div className="space-y-1">
              {buckets.map((bucket, bucketIndex) => {
                const value = numberOr(bucket.count, 0)
                return (
                  <div key={bucketIndex} className="flex items-center gap-2">
                    <span className="w-28 shrink-0 truncate text-foreground">
                      {formatValue(bucket.value)}
                    </span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-foreground/30"
                        style={{ width: `${(value / max) * 100}%` }}
                      />
                    </span>
                    <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
                      {value.toLocaleString()}
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

/** `GET …/telemetry/:prop/history` — latest value plus a clean sparkline. */
export function TelemetryHistoryView({ parsed }: ApiViewProps) {
  const data = toSeriesData(parsed.json)
  if (data.length === 0) return <Empty message="No readings." />
  return <SeriesChart data={data} unit={seriesUnit(parsed.json)} />
}

/** `POST /api/telemetry/history` — one labeled sparkline per series. */
export function TelemetryBulkView({ parsed }: ApiViewProps) {
  const series =
    isRecord(parsed.json) && Array.isArray(parsed.json.series)
      ? parsed.json.series.filter(isRecord)
      : null
  if (!series || series.length === 0) return <Empty message="No series returned." />

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
              {label || `Series ${index + 1}`}
            </p>
            {data.length > 0 ? (
              <SeriesChart data={data} unit={seriesUnit(entry.points)} />
            ) : (
              <Empty message="No readings." />
            )}
          </div>
        )
      })}
    </div>
  )
}

/** `GET /api/object-types/:id` — a single type's schema, in plain labeled sections. */
export function ObjectTypeSchemaView({ parsed }: ApiViewProps) {
  const type = isRecord(parsed.json) ? parsed.json : null
  if (!type) return <ApiDataView parsed={parsed} />

  return (
    <div className="space-y-3">
      {stringField(type, "description") ? (
        <p className="text-muted-foreground">{stringField(type, "description")}</p>
      ) : null}
      <SchemaSection label="Properties" items={namedItems(type.properties)} />
      <SchemaSection label="Links" items={namedItems(type.links)} />
      <SchemaSection label="Actions" items={namedItems(type.actions)} />
    </div>
  )
}

/** `POST /api/actions/:id` — a calm confirmation that a run was requested. */
export function ActionResultView({ parsed }: ApiViewProps) {
  const result = isRecord(parsed.json) ? parsed.json : null
  const runId = result && typeof result.runId === "string" ? result.runId : null
  if (!runId) return <ApiDataView parsed={parsed} />

  const created = result?.created !== false
  const queuedAt = typeof result?.queuedAt === "string" ? result.queuedAt : undefined

  return (
    <div className="space-y-1">
      <p className="text-foreground">
        {created ? "Action requested." : "Action already in progress."}
      </p>
      <p className="text-[11px] text-muted-foreground/60">
        Run <span className="font-mono text-muted-foreground">{runId}</span>
        {queuedAt ? ` · queued ${formatRelativeTime(queuedAt)}` : ""}
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

const CHANGE_VERB: Record<string, string> = {
  create: "Created",
  update: "Updated",
  delete: "Deleted",
}

/** `GET /api/action-runs/:runId` — the run's status, timing, what changed, and any error. */
export function ActionRunView({ parsed }: ApiViewProps) {
  const run = isRecord(parsed.json) ? parsed.json : null
  if (!run) return <ApiDataView parsed={parsed} />

  const status = stringField(run, "status") ?? "queued"
  const subject = subjectLabel(run.subject)
  const error = isRecord(run.error) ? run.error : null
  const diff = isRecord(run.commit) && isRecord(run.commit.diff) ? run.commit.diff : null
  const objectChanges = diff && Array.isArray(diff.objects) ? diff.objects.filter(isRecord) : []
  const linkChanges = diff && Array.isArray(diff.links) ? diff.links.filter(isRecord) : []
  const params = isRecord(run.params) ? Object.entries(run.params) : []

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span
          className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[status] ?? STATUS_DOT.queued)}
        />
        <span className="font-medium text-foreground">{capitalize(status)}</span>
        {subject ? <span className="text-muted-foreground/60">on {subject}</span> : null}
        <span className="ml-auto text-[11px] text-muted-foreground/60">{runTiming(run)}</span>
      </div>

      {error ? (
        <p className="border-l-2 border-destructive/30 pl-3 text-destructive whitespace-pre-wrap">
          {stringField(error, "message") ?? "The action failed."}
        </p>
      ) : null}

      {objectChanges.length > 0 || linkChanges.length > 0 ? (
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
            Changes
          </p>
          <div className="flex flex-col gap-0.5">
            {objectChanges.map((change, index) => (
              <div key={`o-${index}`} className="flex items-baseline gap-2">
                <span className="text-foreground">
                  {CHANGE_VERB[stringField(change, "operation") ?? ""] ?? "Changed"}{" "}
                  {humanize(stringField(change, "objectTypeId")) || "object"}{" "}
                  {stringField(change, "primaryId")}
                </span>
                {Array.isArray(change.changedProperties) && change.changedProperties.length > 0 ? (
                  <span className="text-muted-foreground/60">
                    {change.changedProperties.map((key) => humanize(String(key))).join(", ")}
                  </span>
                ) : null}
              </div>
            ))}
            {linkChanges.map((change, index) => (
              <div key={`l-${index}`} className="text-foreground">
                {CHANGE_VERB[stringField(change, "operation") ?? ""] ?? "Changed"} link{" "}
                {humanize(stringField(change, "linkId")) || stringField(change, "linkId")}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {params.length > 0 ? (
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
            Inputs
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
}: ApiViewProps & { readonly command?: string }) {
  return (
    <div className="space-y-2">
      {command ? (
        <pre className="overflow-x-auto rounded bg-muted/50 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
          <span className="select-none text-muted-foreground/50">$ </span>
          {command}
        </pre>
      ) : null}
      {parsed.stdout.trim() ? (
        <pre className="scrollbar-thin max-h-72 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground">
          {parsed.stdout}
        </pre>
      ) : (
        <Empty message="No output." />
      )}
      {parsed.stderr.trim() ? (
        <pre className="scrollbar-thin max-h-40 overflow-auto rounded px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-destructive">
          {parsed.stderr}
        </pre>
      ) : null}
      {parsed.truncated ? (
        <p className="text-[11px] text-muted-foreground/60">Output truncated.</p>
      ) : null}
    </div>
  )
}

/**
 * Neutral fallback for parsed API responses without a dedicated renderer (project, actions,
 * telemetry) or shapes a renderer didn't recognize. Arrays become a simple list, objects a
 * property sheet of their scalar fields. Never prints raw JSON in the reading path.
 */
export function ApiDataView({ parsed }: ApiViewProps) {
  const json = parsed.json

  if (Array.isArray(json)) {
    const items = json.filter(isRecord)
    if (items.length === 0) return <Empty message="No items returned." />
    return (
      <ul className="space-y-1.5">
        {items.slice(0, MAX_ROWS).map((item, index) => (
          <li key={index}>
            <span className="font-medium text-foreground">
              {stringField(item, "name") ?? stringField(item, "id") ?? `Item ${index + 1}`}
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

interface SeriesPoint {
  readonly value: number
  readonly timestamp: string
}

/** Latest reading + min/max framing a single sparkline. */
function SeriesChart({ data, unit }: { data: readonly SeriesPoint[]; unit?: string }) {
  const values = data.map((point) => point.value)
  const latest = data[data.length - 1]
  const min = Math.min(...values)
  const max = Math.max(...values)

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-semibold tabular-nums text-foreground">
          {latest.value.toLocaleString()}
        </span>
        {unit ? <span className="text-muted-foreground">{unit}</span> : null}
        <span className="ml-auto text-[11px] text-muted-foreground/60">
          {formatRelativeTime(latest.timestamp)}
        </span>
      </div>
      <MiniSparkline data={[...data]} width={560} height={48} showDot className="h-12 w-full" />
      {min !== max ? (
        <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground/60">
          <span>low {min.toLocaleString()}</span>
          <span>high {max.toLocaleString()}</span>
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
  const label =
    total !== null && total > shown
      ? `Showing ${shown} of ${total.toLocaleString()}`
      : `${shown} ${shown === 1 ? "result" : "results"}`
  const suffix = hasMore && (total === null || total <= shown) ? " · more available" : ""
  return <p className="mt-2 text-[11px] text-muted-foreground/60">{`${label}${suffix}`}</p>
}

function Empty({ message }: { message: string }) {
  return <p className="text-muted-foreground/70">{message}</p>
}

function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground/40">—</span>
  }
  if (typeof value === "number")
    return <span className="tabular-nums">{value.toLocaleString()}</span>
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>
  if (typeof value === "string") return <span>{value}</span>
  if (Array.isArray(value))
    return <span className="text-muted-foreground/60">{value.length} items</span>
  return <span className="text-muted-foreground/60">…</span>
}

// --- Helpers ---------------------------------------------------------------

interface ObjectRecord {
  readonly primaryId?: unknown
  readonly properties?: unknown
  readonly [key: string]: unknown
}

function extractObjects(json: unknown): ObjectRecord[] | null {
  if (Array.isArray(json)) return json.filter(isRecord) as ObjectRecord[]
  if (isRecord(json) && Array.isArray(json.objects)) {
    return json.objects.filter(isRecord) as ObjectRecord[]
  }
  return null
}

function singleObject(json: unknown): ObjectRecord | null {
  if (isRecord(json) && isRecord(json.object)) return json.object as ObjectRecord
  if (isRecord(json)) return json as ObjectRecord
  return null
}

/** Most-populated property keys across the first rows, skipping identity echoes. */
function pickColumns(objects: readonly ObjectRecord[]): string[] {
  const counts = new Map<string, number>()
  for (const object of objects.slice(0, 20)) {
    const properties = isRecord(object.properties) ? object.properties : {}
    for (const key of Object.keys(properties)) {
      if (REDUNDANT_KEYS.has(key)) continue
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_COLUMNS)
    .map(([key]) => key)
}

/** Numeric telemetry points, sorted oldest→newest, ready for MiniSparkline. */
function toSeriesData(points: unknown): SeriesPoint[] {
  if (!Array.isArray(points)) return []
  return points
    .filter(isRecord)
    .map((point) => ({
      value: typeof point.value === "number" ? point.value : Number.NaN,
      timestamp: typeof point.at === "string" ? point.at : "",
    }))
    .filter((point) => Number.isFinite(point.value) && point.timestamp !== "")
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))
}

/** The most-advanced timestamp on a run, phrased relatively. */
function runTiming(run: Record<string, unknown>): string {
  const finished = stringField(run, "finishedAt")
  if (finished) return `finished ${formatRelativeTime(finished)}`
  const started = stringField(run, "startedAt")
  if (started) return `started ${formatRelativeTime(started)}`
  const queued = stringField(run, "queuedAt")
  return queued ? `queued ${formatRelativeTime(queued)}` : ""
}

function seriesUnit(points: unknown): string | undefined {
  if (!Array.isArray(points)) return undefined
  for (const point of points) {
    if (isRecord(point) && typeof point.unit === "string") return point.unit
  }
  return undefined
}

/** Name + a short meta hint for properties/links/actions of an object-type definition. */
function namedItems(value: unknown): Array<{ name: string; meta?: string }> {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map((item) => {
    const name = stringField(item, "name") ?? stringField(item, "id") ?? "—"
    const target = stringField(item, "targetObjectTypeId")
    const semanticType = stringField(item, "semanticType")
    const mode = item.mode === "telemetry" ? "telemetry" : undefined
    return { name, meta: target ?? semanticType ?? mode }
  })
}

function metaLine(parts: ReadonlyArray<readonly [number, string, string]>): string {
  return parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
    .join(" · ")
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  return typeof value[field] === "string" ? (value[field] as string) : undefined
}

function numberField(value: unknown, field: string): number | null {
  return isRecord(value) && typeof value[field] === "number" ? (value[field] as number) : null
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback
}

function arrayLen(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—"
  if (typeof value === "string") return value
  if (typeof value === "number") return value.toLocaleString()
  if (typeof value === "boolean") return value ? "Yes" : "No"
  return String(value)
}
