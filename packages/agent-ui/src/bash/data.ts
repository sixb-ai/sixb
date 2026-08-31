// Pure data shaping for the bash renderers: pull the rows, columns, series, and labels a native
// view needs out of decoded CLI output. No React here — these are exercised directly by unit
// tests and re-used by `renderers.tsx`, which owns the JSX.

import { formatRelativeTime } from "../format"
import { isRecord } from "./interpret"

// `numberField` lives in the interpreter (the leaf module that owns `isRecord`); re-export it here so
// data-helper consumers keep a single import site and there is one definition.
export { numberField } from "./interpret"

const MAX_COLUMNS = 5
// Property keys that just echo the row's identity — never worth a column of their own.
const REDUNDANT_KEYS = new Set(["id", "primaryId", "objectTypeId"])

export interface ObjectRecord {
  readonly primaryId?: unknown
  readonly properties?: unknown
  readonly [key: string]: unknown
}

export interface SeriesPoint {
  readonly value: number
  readonly timestamp: string
}

/** Objects across both the list (`[...]`) and query (`{ objects: [...] }`) CLI output shapes. */
export function extractObjects(json: unknown): ObjectRecord[] | null {
  if (Array.isArray(json)) return json.filter(isRecord) as ObjectRecord[]
  if (isRecord(json) && Array.isArray(json.objects)) {
    return json.objects.filter(isRecord) as ObjectRecord[]
  }
  return null
}

/** One object from either the `{ object: {...} }` wrapper or a bare record. */
export function singleObject(json: unknown): ObjectRecord | null {
  if (isRecord(json) && isRecord(json.object)) return json.object as ObjectRecord
  if (isRecord(json)) return json as ObjectRecord
  return null
}

/** Most-populated property keys across the first rows, skipping identity echoes. */
export function pickColumns(objects: readonly ObjectRecord[]): string[] {
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
export function toSeriesData(points: unknown): SeriesPoint[] {
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

/** The unit shared by a telemetry series, taken from the first point that declares one. */
export function seriesUnit(points: unknown): string | undefined {
  if (!Array.isArray(points)) return undefined
  for (const point of points) {
    if (isRecord(point) && typeof point.unit === "string") return point.unit
  }
  return undefined
}

/** The most-advanced timestamp on a run, phrased relatively. */
export function runTiming(run: Record<string, unknown>): string {
  const finished = stringField(run, "finishedAt")
  if (finished) return `finished ${formatRelativeTime(finished)}`
  const started = stringField(run, "startedAt")
  if (started) return `started ${formatRelativeTime(started)}`
  const queued = stringField(run, "queuedAt")
  return queued ? `queued ${formatRelativeTime(queued)}` : ""
}

/** Name + a short meta hint for properties/links/actions of an object-type definition. */
export function namedItems(value: unknown): Array<{ name: string; meta?: string }> {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map((item) => {
    const name = stringField(item, "name") ?? stringField(item, "id") ?? "—"
    const target = stringField(item, "targetObjectTypeId")
    const semanticType = stringField(item, "semanticType")
    const mode = item.mode === "telemetry" ? "telemetry" : undefined
    return { name, meta: target ?? semanticType ?? mode }
  })
}

/** "3 properties · 1 link" from `[count, singular, plural]` triples, dropping the zero counts. */
export function metaLine(parts: ReadonlyArray<readonly [number, string, string]>): string {
  return parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
    .join(" · ")
}

export function stringField(value: Record<string, unknown>, field: string): string | undefined {
  return typeof value[field] === "string" ? (value[field] as string) : undefined
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback
}

export function arrayLen(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—"
  if (typeof value === "string") return value
  if (typeof value === "number") return value.toLocaleString()
  if (typeof value === "boolean") return value ? "Yes" : "No"
  return String(value)
}
