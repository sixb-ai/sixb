import type {
  ObjectAction,
  ObjectSummary,
  RelationshipEdge,
  TelemetryHistory,
  TelemetryProperty,
  TelemetryUpdate,
} from "@sixb/client"
import { decodeObjectId, encodeObjectId, objectIdAliases, telemetryUpdateKey } from "@sixb/client"
import {
  type GetTelemetryHistoryOptions,
  getObjectOptions,
  getTelemetryHistoryOptions,
  listRelationshipsOptions,
} from "@sixb/client/hooks"
import {
  Badge,
  Button,
  Calendar,
  Card,
  EmptyState,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ToggleGroup,
  ToggleGroupItem,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { Box, CalendarIcon } from "lucide-react"
import { Fragment, useEffect, useMemo, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { ActionButton } from "../components/ActionButton"
import { BackNav, LetterAvatar, LoadingState, Section } from "../components/common"
import { FileRefAttachment } from "../components/objects/FileRefAttachment"
import { TelemetryChart } from "../components/TelemetryChart"
import { TelemetryValue } from "../components/TelemetryValue"
import { TelemetryGrid } from "../components/telemetry"
import { UsageBar } from "../components/UsageBar"
import { useObjectLiveUpdates } from "../features/objects/hooks/useObjectLiveUpdates"
import { useObjectTelemetryUpdates } from "../features/objects/hooks/useObjectTelemetryUpdates"
import { type FileValueContext, isFileRefDisplayValue, isFileRefValue } from "../lib/files"
import { formatValue } from "../lib/formatValue"
import { humanizeIdentifier } from "../lib/labels"
import { getHistoryBounds, isSampleInBounds } from "../lib/telemetryHistory"
import { formatRelativeTime } from "../lib/time"

interface ObjectDetailPageProps {
  projectName: string
  objectLookup: Record<string, ObjectSummary>
}

const telemetryRanges = [
  { value: "5m", label: "5m" },
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "custom", label: "Custom" },
] as const

type TelemetryRangeValue = (typeof telemetryRanges)[number]["value"]

const defaultTelemetryRange: TelemetryRangeValue = "7d"

function formatHistoryValue(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "True" : "False"
  return String(value)
}

function qualityDotClass(quality?: "good" | "uncertain" | "bad"): string {
  if (quality === "good") return "bg-emerald-500"
  if (quality === "uncertain") return "bg-amber-500"
  if (quality === "bad") return "bg-red-500"
  return "bg-muted-foreground/40"
}

function telemetryPropertyLabel(
  propertyId: string,
  property?: (TelemetryProperty & { name?: string }) | undefined
): string {
  const explicitName =
    typeof property?.name === "string" && property.name.length > 0 ? property.name : null
  return humanizeIdentifier(explicitName ?? propertyId)
}

function isoTimestamp(date: Date): string {
  return date.toISOString()
}

function parseTimestamp(value: string): Date | null {
  if (!value) return null

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function timestampIso(value: string): string | undefined {
  return parseTimestamp(value)?.toISOString()
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0)
}

function endOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999)
}

function dateBoundaryIso(day: Date, boundary: "start" | "end"): string {
  return isoTimestamp(boundary === "start" ? startOfLocalDay(day) : endOfLocalDay(day))
}

function formatCustomDate(value: string): string {
  const date = parseTimestamp(value)
  if (!date) return "Select date"

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

function telemetryRangeLabel(range: TelemetryRangeValue, fromIso?: string, toIso?: string): string {
  if (range === "5m") return "Last 5 minutes"
  if (range === "1h") return "Last hour"
  if (range === "24h") return "Last 24 hours"
  if (range === "7d") return "Last 7 days"

  const from = fromIso ? new Date(fromIso) : null
  const to = toIso ? new Date(toIso) : null
  if (from && to && !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) {
    return `${from.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: "numeric",
    })} to ${to.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: "numeric",
    })}`
  }

  return "Custom range"
}

function telemetryRangeSentenceLabel(range: TelemetryRangeValue): string {
  if (range === "5m") return "last 5 minutes"
  if (range === "1h") return "last hour"
  if (range === "24h") return "last 24 hours"
  if (range === "7d") return "last 7 days"
  return "selected range"
}

function latestUpdateForProperty(
  latestUpdates: Record<string, TelemetryUpdate>,
  projectName: string,
  objectIds: readonly string[],
  propertyId: string
): TelemetryUpdate | null {
  let latest: TelemetryUpdate | null = null

  for (const objectId of objectIds) {
    const update = latestUpdates[telemetryUpdateKey(projectName, objectId, propertyId)]
    if (!update) continue

    if (!latest || +new Date(update.timestamp) > +new Date(latest.timestamp)) {
      latest = update
    }
  }

  return latest
}

interface ActionPresentation {
  tone: "default" | "primary" | "danger"
  featured: boolean
  requireConfirm: boolean
}

function getActionPresentation(actionId: string): ActionPresentation {
  const id = actionId.toLowerCase()
  const has = (pattern: RegExp) => pattern.test(id)

  const dangerous =
    has(/^(power[-_ ]?off|shutdown|restart|reboot|factory[-_ ]?reset|erase|delete|remove|kill)$/) ||
    has(
      /[-_ ](power[-_ ]?off|shutdown|restart|reboot|factory[-_ ]?reset|erase|delete|remove|kill)$/
    )
  if (dangerous) {
    return { tone: "danger", featured: true, requireConfirm: true }
  }

  const primary =
    has(
      /^(power[-_ ]?on|play|pause|resume|stop|launch|home|back|mute|unmute|volume[-_ ]?\w+|toggle[-_ ]?\w+)$/
    ) ||
    has(
      /[-_ ](power[-_ ]?on|play|pause|resume|stop|launch|home|back|mute|unmute|volume[-_ ]?\w+|toggle[-_ ]?\w+)$/
    )
  if (primary) {
    return { tone: "primary", featured: true, requireConfirm: false }
  }

  return { tone: "default", featured: false, requireConfirm: false }
}

function getUsagePercent(
  telemetry: Record<string, TelemetryProperty>,
  objectClass: string
): number | null {
  const type = objectClass
  const usageMap: Record<string, () => number | null> = {
    memory: () =>
      telemetry.pressure?.currentValue != null ? Number(telemetry.pressure.currentValue) : null,
    processor: () =>
      telemetry.usage?.currentValue != null ? Number(telemetry.usage.currentValue) : null,
    battery: () =>
      telemetry.level?.currentValue != null ? Number(telemetry.level.currentValue) : null,
    graphics: () =>
      telemetry.usage?.currentValue != null ? Number(telemetry.usage.currentValue) : null,
    gpu: () =>
      telemetry.usage?.currentValue != null ? Number(telemetry.usage.currentValue) : null,
    storage: () => {
      const used = telemetry.used?.currentValue
      const free = telemetry.free?.currentValue
      return typeof used === "number" && typeof free === "number"
        ? (used / (used + free)) * 100
        : null
    },
  }
  for (const [key, getValue] of Object.entries(usageMap)) {
    if (type.includes(key)) return getValue()
  }
  return null
}

export function ObjectDetailPage({ projectName, objectLookup }: ObjectDetailPageProps) {
  const { objectId } = useParams<{ objectId: string }>()
  const navigate = useNavigate()
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(null)
  const [trendDismissed, setTrendDismissed] = useState(false)
  const [telemetryRange, setTelemetryRange] = useState<TelemetryRangeValue>(defaultTelemetryRange)
  const [customFrom, setCustomFrom] = useState(() =>
    isoTimestamp(startOfLocalDay(new Date(Date.now() - 7 * 86_400_000)))
  )
  const [customTo, setCustomTo] = useState(() => isoTimestamp(endOfLocalDay(new Date())))
  useObjectLiveUpdates({ objectId, enabled: Boolean(projectName && objectId) })
  const latestUpdates = useObjectTelemetryUpdates(projectName, objectId, {
    enabled: Boolean(objectId),
  })

  useEffect(() => {
    if (!objectId) return
    setSelectedPropertyId(null)
    setTrendDismissed(false)
  }, [objectId])

  const canonicalObjectId = useMemo(() => {
    if (!objectId) return null
    const parsed = decodeObjectId(objectId)
    return parsed ? encodeObjectId(parsed.objectTypeId, parsed.primaryId) : objectId
  }, [objectId])

  const { data: object, isLoading: objectLoading } = useQuery({
    ...getObjectOptions({
      path: { projectName, objectId: objectId! },
    }),
    enabled: !!objectId,
  })

  const { data: relationships = [] } = useQuery({
    ...listRelationshipsOptions({
      path: { projectName },
      query: { objectId: canonicalObjectId ?? undefined },
    }),
    enabled: !!objectId,
  })

  const liveObjectIdAliases = useMemo(() => {
    const ids = [objectId, canonicalObjectId, object?.id, object?.primaryId].filter(
      (id): id is string => typeof id === "string" && id.length > 0
    )
    return Array.from(new Set(ids.flatMap((id) => objectIdAliases(id))))
  }, [objectId, canonicalObjectId, object?.id, object?.primaryId])

  const liveObjectIdAliasSet = useMemo(() => new Set(liveObjectIdAliases), [liveObjectIdAliases])

  const latestTelemetryUpdates = useMemo(() => {
    if (liveObjectIdAliasSet.size === 0) return {}

    const byProperty = new Map<string, TelemetryUpdate>()
    for (const update of Object.values(latestUpdates)) {
      if (update.projectName !== projectName) continue
      if (!liveObjectIdAliasSet.has(update.objectId)) continue

      const previous = byProperty.get(update.propertyId)
      if (!previous || +new Date(update.timestamp) > +new Date(previous.timestamp)) {
        byProperty.set(update.propertyId, update)
      }
    }

    return Object.fromEntries(
      Array.from(byProperty.entries()).map(([propertyId, update]) => [
        propertyId,
        { value: update.value, quality: update.quality },
      ])
    )
  }, [latestUpdates, projectName, liveObjectIdAliasSet])

  const telemetryProperties = useMemo(
    () => (object?.telemetry as Record<string, TelemetryProperty>) ?? {},
    [object]
  )

  const telemetryWithLive = useMemo(() => {
    const telemetryMap = (object?.telemetry || {}) as Record<string, TelemetryProperty>
    return Object.fromEntries(
      Object.entries(telemetryMap).map(([id, property]) => {
        const live = latestTelemetryUpdates[id]
        if (!live) return [id, property]
        return [
          id,
          { ...property, currentValue: live.value, quality: live.quality ?? property.quality },
        ]
      })
    ) as Record<string, TelemetryProperty>
  }, [object?.telemetry, latestTelemetryUpdates])

  const numericPropertyIds = useMemo(() => {
    return Object.keys(telemetryProperties).filter((propertyId) => {
      const property = telemetryProperties[propertyId]
      if (!property) return false
      if (property.dataType === "number") return true
      const live = latestTelemetryUpdates[propertyId]?.value
      if (typeof live === "number") return true
      return typeof property.currentValue === "number"
    })
  }, [telemetryProperties, latestTelemetryUpdates])

  const defaultNumericPropertyId = useMemo(() => {
    if (!objectId || numericPropertyIds.length === 0) return null
    const recentNumericUpdate = Object.values(latestUpdates)
      .filter(
        (update) =>
          update.projectName === projectName &&
          liveObjectIdAliasSet.has(update.objectId) &&
          numericPropertyIds.includes(update.propertyId)
      )
      .sort((left, right) => +new Date(right.timestamp) - +new Date(left.timestamp))[0]
    if (recentNumericUpdate) return recentNumericUpdate.propertyId
    return numericPropertyIds[0]
  }, [objectId, numericPropertyIds, latestUpdates, projectName, liveObjectIdAliasSet])

  useEffect(() => {
    if (!object) return
    if (trendDismissed) return
    if (selectedPropertyId && telemetryProperties[selectedPropertyId]) return
    if (defaultNumericPropertyId) {
      setSelectedPropertyId(defaultNumericPropertyId)
    }
  }, [object, trendDismissed, selectedPropertyId, telemetryProperties, defaultNumericPropertyId])

  const selectedPropertyUnit = selectedPropertyId
    ? telemetryProperties[selectedPropertyId]?.unit
    : undefined

  const selectedProperty = selectedPropertyId ? telemetryProperties[selectedPropertyId] : undefined
  const selectedPropertyLabel = selectedPropertyId
    ? telemetryPropertyLabel(selectedPropertyId, selectedProperty)
    : ""
  const selectedPropertyLatestUpdate = selectedPropertyId
    ? latestUpdateForProperty(latestUpdates, projectName, liveObjectIdAliases, selectedPropertyId)
    : null
  const customFromIso = useMemo(() => timestampIso(customFrom), [customFrom])
  const customToIso = useMemo(() => timestampIso(customTo), [customTo])
  const telemetryHistoryEnabled =
    telemetryRange !== "custom" || (customFromIso !== undefined && customToIso !== undefined)
  const telemetryHistoryQuery = useMemo<GetTelemetryHistoryOptions["query"]>(() => {
    if (telemetryRange === "custom") {
      return {
        from: customFromIso,
        to: customToIso,
        order: "asc",
      }
    }

    return {
      range: telemetryRange,
      order: "asc",
    }
  }, [telemetryRange, customFromIso, customToIso])
  const telemetryRangeLabelText = useMemo(
    () => telemetryRangeLabel(telemetryRange, customFromIso, customToIso),
    [telemetryRange, customFromIso, customToIso]
  )
  const telemetryRangeSampleLabel = telemetryRangeSentenceLabel(telemetryRange)

  const selectedPropertyIsNumeric = useMemo(() => {
    if (!selectedPropertyId) return false
    const property = telemetryProperties[selectedPropertyId]
    if (!property) return false
    if (property.dataType === "number") return true
    const live = latestTelemetryUpdates[selectedPropertyId]?.value
    if (typeof live === "number") return true
    return typeof property.currentValue === "number"
  }, [selectedPropertyId, telemetryProperties, latestTelemetryUpdates])

  const {
    data: selectedPropertyHistory,
    isLoading: selectedPropertyHistoryLoading,
    error: selectedPropertyHistoryError,
  } = useQuery({
    ...getTelemetryHistoryOptions({
      path: { projectName, objectId: objectId!, propertyId: selectedPropertyId! },
      query: telemetryHistoryQuery,
    }),
    enabled:
      !!objectId && !!selectedPropertyId && !selectedPropertyIsNumeric && telemetryHistoryEnabled,
  })

  const nonNumericHistory = useMemo(() => {
    if (!selectedPropertyId || selectedPropertyIsNumeric) return null

    const historySamples =
      ((selectedPropertyHistory as TelemetryHistory | undefined)?.data ?? []).filter(
        (sample) => typeof sample.value !== "number"
      ) || []

    const mergedSamples = [...historySamples]
    if (selectedPropertyLatestUpdate && typeof selectedPropertyLatestUpdate.value !== "number") {
      const latestSample = {
        value: selectedPropertyLatestUpdate.value,
        timestamp: selectedPropertyLatestUpdate.timestamp,
        quality: selectedPropertyLatestUpdate.quality,
      }
      const bounds = getHistoryBounds(telemetryHistoryQuery)
      const duplicate = mergedSamples.some(
        (sample) =>
          sample.timestamp === latestSample.timestamp && sample.value === latestSample.value
      )
      if (!duplicate && isSampleInBounds(latestSample, bounds)) mergedSamples.push(latestSample)
    }

    mergedSamples.sort((left, right) => +new Date(left.timestamp) - +new Date(right.timestamp))

    const transitions: Array<{
      value: string | boolean
      timestamp: string
      quality?: "good" | "uncertain" | "bad"
    }> = []
    for (const sample of mergedSamples) {
      const nextValue = sample.value as string | boolean
      const previous = transitions[transitions.length - 1]
      if (!previous || previous.value !== nextValue) {
        transitions.push({ value: nextValue, timestamp: sample.timestamp, quality: sample.quality })
        continue
      }
      transitions[transitions.length - 1] = {
        value: nextValue,
        timestamp: sample.timestamp,
        quality: sample.quality ?? previous.quality,
      }
    }

    const frequencies = new Map<string, number>()
    for (const sample of mergedSamples) {
      const key = formatHistoryValue(sample.value as string | number | boolean)
      frequencies.set(key, (frequencies.get(key) ?? 0) + 1)
    }

    return {
      current: transitions[transitions.length - 1] ?? null,
      transitions: [...transitions].reverse().slice(0, 8),
      frequencies: Array.from(frequencies.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((left, right) => right.count - left.count),
      sampleCount: mergedSamples.length,
    }
  }, [
    selectedPropertyId,
    selectedPropertyIsNumeric,
    selectedPropertyHistory,
    selectedPropertyLatestUpdate,
    telemetryHistoryQuery,
  ])

  const actions = useMemo(() => {
    const entries = Object.entries(
      (object?.actions as Record<string, ObjectAction> | undefined) || {}
    )
    const featured: Array<{
      actionId: string
      action: ObjectAction
      presentation: ActionPresentation
    }> = []
    const regular: Array<{
      actionId: string
      action: ObjectAction
      presentation: ActionPresentation
    }> = []
    for (const [actionId, action] of entries) {
      const presentation = getActionPresentation(actionId)
      if (presentation.featured) {
        featured.push({ actionId, action, presentation })
      } else {
        regular.push({ actionId, action, presentation })
      }
    }
    return { featured, regular, total: entries.length }
  }, [object?.actions])

  const outgoing = useMemo(
    () => relationships.filter((r) => r.source === canonicalObjectId),
    [relationships, canonicalObjectId]
  )
  const incoming = useMemo(
    () => relationships.filter((r) => r.target === canonicalObjectId),
    [relationships, canonicalObjectId]
  )

  const usagePercent = object ? getUsagePercent(telemetryWithLive, object.class) : null

  if (!objectId) {
    return (
      <Card className="p-6">
        <EmptyState
          icon={<Box className="size-12 stroke-1" />}
          title="Object missing"
          description="No object id was provided in the route."
        />
      </Card>
    )
  }

  if (objectLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <LoadingState label="Loading object..." />
      </div>
    )
  }

  if (!object) {
    return (
      <div className="flex items-center justify-center py-20">
        <Card className="mx-auto max-w-md p-6 text-center">
          <EmptyState
            icon={<Box className="size-12 stroke-1" />}
            title="Object not found"
            description="The selected object is unavailable in this project."
          />
          <Button
            variant="outline"
            size="sm"
            className="mx-auto mt-2"
            onClick={() => navigate("/")}
          >
            Back to objects
          </Button>
        </Card>
      </div>
    )
  }

  const properties = (object.properties ?? {}) as Record<string, unknown>
  const titleProp =
    typeof properties.title === "string"
      ? properties.title
      : typeof properties.name === "string"
        ? properties.name
        : null
  const displayName = object.name || titleProp || object.id

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <BackNav to="/" label="Objects" />

      <header className="flex items-start gap-4">
        <LetterAvatar label={displayName} size="lg" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground break-words">
            {displayName}
          </h1>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <Link
              to={`/ontology/${object.class}`}
              className="text-foreground underline-offset-2 hover:underline"
            >
              {humanizeIdentifier(object.class)}
            </Link>
            <span aria-hidden="true" className="text-border">
              ·
            </span>
            <code className="font-mono">{object.id}</code>
            {object.updatedAt ? (
              <>
                <span aria-hidden="true" className="text-border">
                  ·
                </span>
                <span>Updated {formatRelativeTime(object.updatedAt)}</span>
              </>
            ) : null}
          </div>
          {usagePercent !== null ? (
            <div className="mt-3 flex max-w-xs items-center gap-3">
              <UsageBar value={usagePercent} size="sm" />
              <span className="text-sm font-semibold tabular-nums text-foreground">
                {usagePercent.toFixed(0)}%
              </span>
            </div>
          ) : null}
        </div>
      </header>

      {Object.keys(telemetryWithLive).length > 0 ? (
        <Section title="Telemetries" count={Object.keys(telemetryWithLive).length}>
          <TelemetryGrid
            telemetry={telemetryWithLive}
            selectedPropertyId={selectedPropertyId}
            onSelectProperty={(propertyId) => {
              setTrendDismissed(false)
              setSelectedPropertyId(propertyId)
            }}
            latestUpdates={latestTelemetryUpdates}
            hideSingleGroupHeader
          />
        </Section>
      ) : null}

      {selectedPropertyId ? (
        <Section title="Trend">
          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <ToggleGroup
                type="single"
                value={telemetryRange}
                onValueChange={(next) => {
                  if (next) setTelemetryRange(next as TelemetryRangeValue)
                }}
                variant="outline"
                size="sm"
                className="flex-wrap"
              >
                {telemetryRanges.map((range) => (
                  <ToggleGroupItem key={range.value} value={range.value}>
                    {range.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              {telemetryRange === "custom" ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <TelemetryDatePicker
                    label="From"
                    boundary="start"
                    value={customFrom}
                    onChange={setCustomFrom}
                  />
                  <TelemetryDatePicker
                    label="To"
                    boundary="end"
                    value={customTo}
                    onChange={setCustomTo}
                  />
                </div>
              ) : null}
            </div>
            {selectedPropertyIsNumeric ? (
              <TelemetryChart
                objectId={object.id}
                propertyId={selectedPropertyId}
                projectName={projectName}
                propertyLabel={selectedPropertyLabel}
                rangeLabel={telemetryRangeLabelText}
                historyQuery={telemetryHistoryQuery}
                historyEnabled={telemetryHistoryEnabled}
                objectDisplayName={displayName}
                unit={selectedPropertyUnit}
                latestUpdate={selectedPropertyLatestUpdate}
                onClose={() => {
                  setTrendDismissed(true)
                  setSelectedPropertyId(null)
                }}
              />
            ) : (
              <Card className="overflow-hidden p-0">
                <div className="space-y-3 border-b border-border px-4 py-4">
                  <div className="min-w-0">
                    <h3 className="text-[14px] font-semibold tracking-tight text-foreground sm:text-[15px]">
                      {selectedPropertyLabel}
                    </h3>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {displayName} / {telemetryRangeLabelText}
                    </p>
                  </div>
                  {selectedPropertyHistoryLoading ? (
                    <LoadingState />
                  ) : nonNumericHistory?.current ? (
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <TelemetryValue
                        value={nonNumericHistory.current.value}
                        quality={nonNumericHistory.current.quality}
                        size="lg"
                      />
                      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span>
                          Changed {formatRelativeTime(nonNumericHistory.current.timestamp)}
                        </span>
                        <span className="text-border">|</span>
                        <span>
                          {nonNumericHistory.sampleCount} samples in {telemetryRangeSampleLabel}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No history yet.</p>
                  )}
                </div>

                {selectedPropertyHistoryError ? (
                  <div className="px-4 py-3">
                    <p className="text-sm text-red-500">
                      Failed to load history: {String(selectedPropertyHistoryError)}
                    </p>
                  </div>
                ) : nonNumericHistory?.transitions.length ? (
                  <div className="max-h-56 divide-y divide-border/40 overflow-auto">
                    {nonNumericHistory.transitions.map((transition) => (
                      <div
                        key={`${transition.timestamp}:${String(transition.value)}`}
                        className="flex items-center justify-between gap-3 px-4 py-2.5"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${qualityDotClass(
                              transition.quality
                            )}`}
                          />
                          <span className="truncate text-sm font-medium text-foreground">
                            {formatHistoryValue(transition.value)}
                          </span>
                        </div>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {new Date(transition.timestamp).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="px-4 py-3">
                    <p className="text-sm text-muted-foreground">No state transitions recorded.</p>
                  </div>
                )}

                {nonNumericHistory && nonNumericHistory.frequencies.length > 1 ? (
                  <div className="border-t border-border px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className="shrink-0 text-[11px] uppercase tracking-wider text-muted-foreground">
                        Distribution
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {nonNumericHistory.frequencies.map((entry) => (
                          <span
                            key={entry.value}
                            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground"
                          >
                            <span className="font-medium">{entry.value}</span>
                            <span className="text-muted-foreground">x{entry.count}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
              </Card>
            )}
          </div>
        </Section>
      ) : null}

      {Object.keys(properties).length > 0 ? (
        <Section title="Details">
          <DetailsList
            objectTypeId={object.objectTypeId}
            primaryId={object.primaryId}
            properties={properties}
          />
        </Section>
      ) : null}

      {outgoing.length > 0 || incoming.length > 0 ? (
        <Section title="Links" count={outgoing.length + incoming.length}>
          <LinksList
            outgoing={outgoing}
            incoming={incoming}
            objectLookup={objectLookup}
            onSelectObject={(id) => navigate(`/${id}`)}
          />
        </Section>
      ) : null}

      {actions.total > 0 ? (
        <Section title="Actions" count={actions.total}>
          <div className="space-y-3">
            {actions.featured.length > 0 ? (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {actions.featured.map(({ actionId, action, presentation }) => (
                  <ActionButton
                    key={actionId}
                    objectId={object.id}
                    actionId={actionId}
                    action={action}
                    tone={presentation.tone}
                    size="prominent"
                    requireConfirm={presentation.requireConfirm}
                  />
                ))}
              </div>
            ) : null}
            {actions.regular.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {actions.regular.map(({ actionId, action, presentation }) => (
                  <ActionButton
                    key={actionId}
                    objectId={object.id}
                    actionId={actionId}
                    action={action}
                    tone={presentation.tone}
                    requireConfirm={presentation.requireConfirm}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </Section>
      ) : null}
    </div>
  )
}

function TelemetryDatePicker({
  label,
  boundary,
  value,
  onChange,
}: {
  label: string
  boundary: "start" | "end"
  value: string
  onChange: (value: string) => void
}) {
  const selectedDate = parseTimestamp(value) ?? new Date()

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 justify-start gap-2 px-2.5 text-left font-normal sm:w-56"
        >
          <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="min-w-0 truncate">
            {label} {formatCustomDate(value)}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-0">
        <Calendar
          mode="single"
          selected={selectedDate}
          onSelect={(day) => {
            if (day) onChange(dateBoundaryIso(day, boundary))
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

function DetailsList({
  objectTypeId,
  primaryId,
  properties,
}: {
  objectTypeId: string
  primaryId: string
  properties: Record<string, unknown>
}) {
  const rows = useMemo(() => {
    const list: Array<{
      key: string
      label: string
      kind: "value" | "primary"
      value?: unknown
    }> = []

    if (typeof properties.id !== "undefined") {
      list.push({ key: "id", label: "ID", kind: "primary", value: properties.id })
    }

    for (const [key, value] of Object.entries(properties)) {
      if (key === "id") continue
      list.push({ key, label: humanizeIdentifier(key), kind: "value", value })
    }

    return list
  }, [properties])

  if (rows.length === 0) return null

  return (
    <Card className="p-4 sm:p-5">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-6 gap-y-2.5 text-sm">
        {rows.map((row) => {
          const fileValue = isFileRefDisplayValue(row.value)

          return (
            <Fragment key={row.key}>
              <dt
                className={cn(
                  "flex gap-1.5 text-xs text-muted-foreground",
                  fileValue ? "self-start items-start pt-2" : "items-baseline"
                )}
              >
                <span>{row.label}</span>
                {row.kind === "primary" ? (
                  <Badge
                    variant="secondary"
                    className="h-4 border-0 bg-emerald-500/15 px-1.5 font-mono text-[9px] font-medium text-emerald-700 dark:text-emerald-400"
                  >
                    id
                  </Badge>
                ) : null}
              </dt>
              <dd className={cn("min-w-0 text-foreground", fileValue && "self-start")}>
                <FormattedValue
                  value={row.value}
                  fileContext={{ objectTypeId, primaryId, pathSegments: [row.key] }}
                />
              </dd>
            </Fragment>
          )
        })}
      </dl>
    </Card>
  )
}

function LinksList({
  outgoing,
  incoming,
  objectLookup,
  onSelectObject,
}: {
  outgoing: RelationshipEdge[]
  incoming: RelationshipEdge[]
  objectLookup: Record<string, ObjectSummary>
  onSelectObject: (id: string) => void
}) {
  const rows = useMemo(() => {
    const linkRows = [
      ...outgoing.map((edge) => ({
        key: `out:${edge.type}:${edge.target}`,
        direction: "to" as const,
        edge,
        relatedId: edge.target,
      })),
      ...incoming.map((edge) => ({
        key: `in:${edge.type}:${edge.source}`,
        direction: "from" as const,
        edge,
        relatedId: edge.source,
      })),
    ]

    return linkRows.sort((a, b) => {
      if (a.direction !== b.direction) return a.direction === "to" ? -1 : 1
      const typeCompare = a.edge.type.localeCompare(b.edge.type)
      if (typeCompare !== 0) return typeCompare
      const aName = objectLookup[a.relatedId]?.name ?? a.relatedId
      const bName = objectLookup[b.relatedId]?.name ?? b.relatedId
      return aName.localeCompare(bName)
    })
  }, [incoming, objectLookup, outgoing])

  return (
    <Card className="p-4 sm:p-5">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-6 gap-y-2.5 text-sm">
        {rows.map((row) => {
          const related = objectLookup[row.relatedId]
          return (
            <Fragment key={row.key}>
              <dt className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
                <span>{humanizeIdentifier(row.edge.type)}</span>
                <Badge
                  variant="secondary"
                  className="h-4 border-0 bg-muted px-1.5 text-[9px] font-medium text-muted-foreground"
                >
                  {row.direction}
                </Badge>
              </dt>
              <dd className="min-w-0 text-foreground">
                <RelatedObjectLink
                  objectId={row.relatedId}
                  related={related}
                  onSelect={onSelectObject}
                />
              </dd>
            </Fragment>
          )
        })}
      </dl>
    </Card>
  )
}

function RelatedObjectLink({
  objectId,
  related,
  onSelect,
}: {
  objectId: string
  related: ObjectSummary | undefined
  onSelect: (id: string) => void
}) {
  return (
    <Link
      to={`/${objectId}`}
      onClick={(event) => {
        event.preventDefault()
        onSelect(objectId)
      }}
      className="inline-flex items-baseline gap-1.5 underline-offset-2 hover:underline"
      title={objectId}
    >
      <span>{related?.name ?? objectId}</span>
      {related?.class ? (
        <span className="text-xs text-muted-foreground">{humanizeIdentifier(related.class)}</span>
      ) : null}
    </Link>
  )
}

function FormattedValue({
  value,
  fileContext,
}: {
  value: unknown
  fileContext?: FileValueContext
}) {
  if (fileContext && isFileRefValue(value)) {
    return <FileRefAttachment fileRef={value} {...fileContext} />
  }

  if (fileContext && Array.isArray(value) && value.length > 0 && value.every(isFileRefValue)) {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        {value.map((fileRef, index) => (
          <FileRefAttachment
            key={`${fileRef.blobId}:${index}`}
            fileRef={fileRef}
            objectTypeId={fileContext.objectTypeId}
            primaryId={fileContext.primaryId}
            pathSegments={[...fileContext.pathSegments, String(index)]}
          />
        ))}
      </div>
    )
  }

  if (isIsoDateString(value)) {
    return <span title={value}>{formatIsoDate(value)}</span>
  }
  const formatted = formatValue(value)
  const isComplex = value !== null && typeof value === "object"
  const isMonoFriendly =
    !isComplex && (/^[a-z][a-z0-9_-]*$/i.test(formatted) || /^\d+$/.test(formatted))
  return (
    <span
      className={cn(
        "break-words",
        isComplex && "font-mono text-xs leading-relaxed",
        isMonoFriendly && "font-mono"
      )}
    >
      {formatted}
    </span>
  )
}

function isIsoDateString(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)
}

function formatIsoDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}
