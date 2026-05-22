import type {
  ObjectAction,
  ObjectSummary,
  RelationshipEdge,
  TelemetryHistory,
  TelemetryProperty,
} from "@pario/client"
import {
  getObjectOptions,
  getTelemetryHistoryOptions,
  listRelationshipsOptions,
} from "@pario/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import type { TelemetryUpdate } from "../hooks/useWebSocket"
import { formatValue } from "../lib/formatValue"
import { humanizeIdentifier } from "../lib/labels"
import { formatRelativeTime } from "../lib/time"
import { cn } from "../lib/utils"
import { ActionButton } from "./ActionButton"
import { EmptyState, EmptyStateIcons, GlassCard, LoadingSpinner } from "./common"
import { ObjectIcon } from "./ObjectIcon"
import { TelemetryChart } from "./TelemetryChart"
import { TelemetryValue } from "./TelemetryValue"
import { TelemetryGrid } from "./telemetry"
import { UsageBar } from "./UsageBar"
import { Badge } from "./ui/badge"

interface ObjectDetailPageProps {
  projectName: string
  latestUpdates: Record<string, TelemetryUpdate>
  objectLookup: Record<string, ObjectSummary>
}

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

export function ObjectDetailPage({
  projectName,
  latestUpdates,
  objectLookup,
}: ObjectDetailPageProps) {
  const { objectId } = useParams<{ objectId: string }>()
  const navigate = useNavigate()
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(null)

  useEffect(() => {
    if (!objectId) return
    setSelectedPropertyId(null)
  }, [objectId])

  const { data: object, isLoading: objectLoading } = useQuery({
    ...getObjectOptions({
      path: { projectName, objectId: objectId! },
    }),
    enabled: !!objectId,
  })

  const { data: relationships = [], isLoading: relationshipsLoading } = useQuery({
    ...listRelationshipsOptions({
      path: { projectName },
      query: { objectId: objectId ?? undefined },
    }),
    enabled: !!objectId,
  })

  const latestTelemetryUpdates = useMemo(() => {
    if (!objectId) return {}
    const prefix = `${projectName}:${objectId}:`
    const entries = Object.entries(latestUpdates)
      .filter(([key]) => key.startsWith(prefix))
      .map(([, update]) => [update.propertyId, { value: update.value, quality: update.quality }])
    return Object.fromEntries(entries)
  }, [latestUpdates, projectName, objectId])

  const telemetryProperties = useMemo(
    () =>
      (object?.telemetry as Record<
        string,
        { class?: string; dataType?: string; currentValue?: unknown; unit?: string }
      >) ?? {},
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
          update.objectId === objectId &&
          numericPropertyIds.includes(update.propertyId)
      )
      .sort((left, right) => +new Date(right.timestamp) - +new Date(left.timestamp))[0]
    if (recentNumericUpdate) return recentNumericUpdate.propertyId
    return numericPropertyIds[0]
  }, [objectId, numericPropertyIds, latestUpdates, projectName])

  useEffect(() => {
    if (!object) return
    if (selectedPropertyId && telemetryProperties[selectedPropertyId]) return
    if (defaultNumericPropertyId) {
      setSelectedPropertyId(defaultNumericPropertyId)
    }
  }, [object, selectedPropertyId, telemetryProperties, defaultNumericPropertyId])

  const selectedPropertyUnit = selectedPropertyId
    ? telemetryProperties[selectedPropertyId]?.unit
    : undefined

  const selectedPropertyLatestUpdate =
    selectedPropertyId && objectId
      ? (latestUpdates[`${projectName}:${objectId}:${selectedPropertyId}`] ?? null)
      : null

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
      query: { range: "5m" },
    }),
    enabled: !!objectId && !!selectedPropertyId && !selectedPropertyIsNumeric,
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
      const duplicate = mergedSamples.some(
        (sample) =>
          sample.timestamp === latestSample.timestamp && sample.value === latestSample.value
      )
      if (!duplicate) mergedSamples.push(latestSample)
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
  ])

  // Actions
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

  // Relationships
  const outgoing = relationships.filter((r) => r.source === objectId)
  const incoming = relationships.filter((r) => r.target === objectId)

  const groupRelationships = (edges: RelationshipEdge[]) => {
    const groups = new Map<string, RelationshipEdge[]>()
    for (const edge of edges) {
      const existing = groups.get(edge.type) ?? []
      existing.push(edge)
      groups.set(edge.type, existing)
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b))
  }

  const usagePercent = object ? getUsagePercent(telemetryWithLive, object.class) : null

  if (!objectId) {
    return (
      <GlassCard>
        <EmptyState
          icon={EmptyStateIcons.cube}
          title="Object missing"
          description="No object id was provided in the route."
        />
      </GlassCard>
    )
  }

  if (objectLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <LoadingSpinner text="Loading object..." />
      </div>
    )
  }

  if (!object) {
    return (
      <div className="flex items-center justify-center py-20">
        <GlassCard className="max-w-md text-center">
          <EmptyState
            icon={EmptyStateIcons.cube}
            title="Object not found"
            description="The selected object is unavailable in this project."
          />
          <button
            type="button"
            onClick={() => navigate("/")}
            className="mt-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:bg-accent/40 hover:text-foreground"
          >
            Back to objects
          </button>
        </GlassCard>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="shrink-0 rounded-xl bg-accent/60 p-2.5 text-foreground">
            <ObjectIcon type={object.class} />
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-foreground truncate">
              {object.name || object.id}
            </h1>
            <p className="text-xs text-muted-foreground">{object.class}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {usagePercent !== null && (
            <div className="hidden sm:flex items-center gap-2.5 w-32">
              <UsageBar value={usagePercent} size="sm" />
              <span className="text-sm font-semibold text-foreground tabular-nums">
                {usagePercent.toFixed(0)}%
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={() => navigate("/")}
            className="rounded-lg border border-border/60 bg-card/60 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:bg-accent/40 hover:text-foreground"
          >
            Back
          </button>
        </div>
      </div>

      {/* Usage bar on mobile */}
      {usagePercent !== null && (
        <div className="flex items-center gap-3 sm:hidden">
          <UsageBar value={usagePercent} size="sm" />
          <span className="text-sm font-semibold text-foreground tabular-nums shrink-0">
            {usagePercent.toFixed(0)}%
          </span>
        </div>
      )}

      {/* ── Properties ── */}
      {object.properties && Object.keys(object.properties).length > 0 && (
        <div className="rounded-xl border border-border/60 bg-card shadow-sm overflow-hidden">
          <div className="px-4 py-2.5 bg-muted/60 border-b border-border/50">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Properties
              </span>
              <Badge variant="secondary" className="text-[10px] bg-accent/70">
                {Object.keys(object.properties).length}
              </Badge>
            </div>
          </div>
          <div className="p-4">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {Object.entries(object.properties).map(([key, value]) => (
                <PropertyTile key={key} propertyKey={key} value={value} isPrimary={key === "id"} />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Actions ── */}
      {actions.total > 0 && (
        <div className="rounded-xl border border-border/60 bg-card shadow-sm overflow-hidden">
          <div className="px-4 py-2.5 bg-muted/60 border-b border-border/50">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Actions
              </span>
              <Badge variant="secondary" className="text-[10px] bg-accent/70">
                {actions.total}
              </Badge>
            </div>
          </div>
          <div className="p-4 space-y-3">
            {actions.featured.length > 0 && (
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
            )}
            {actions.regular.length > 0 && (
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
            )}
          </div>
        </div>
      )}

      {/* ── Telemetry ── */}
      {Object.keys(telemetryWithLive).length > 0 && (
        <div className="rounded-xl border border-border/60 bg-card shadow-sm overflow-hidden">
          <div className="px-4 py-2.5 bg-muted/60 border-b border-border/50">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Telemetry
              </span>
              <Badge variant="secondary" className="text-[10px] bg-accent/70">
                {Object.keys(telemetryWithLive).length}
              </Badge>
            </div>
          </div>
          <div className="p-4">
            <TelemetryGrid
              telemetry={telemetryWithLive}
              selectedPropertyId={selectedPropertyId}
              onSelectProperty={setSelectedPropertyId}
              latestUpdates={latestTelemetryUpdates}
            />
          </div>
        </div>
      )}

      {/* ── Trend / Chart ── */}
      {selectedPropertyId && (
        <div>
          <div className="flex items-center gap-2 mb-2 px-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Trend
            </span>
            <span className="rounded-md bg-accent/60 px-2 py-0.5 text-xs text-foreground font-mono">
              {selectedPropertyId}
            </span>
          </div>

          {selectedPropertyIsNumeric ? (
            <TelemetryChart
              objectId={object.id}
              propertyId={selectedPropertyId}
              projectName={projectName}
              unit={selectedPropertyUnit}
              latestUpdate={selectedPropertyLatestUpdate}
              onClose={() => setSelectedPropertyId(defaultNumericPropertyId)}
            />
          ) : (
            <div className="rounded-xl border border-border/60 bg-card shadow-sm overflow-hidden">
              {/* Current value header */}
              <div className="px-4 py-4 border-b border-border/50">
                {selectedPropertyHistoryLoading ? (
                  <LoadingSpinner text="Loading..." />
                ) : nonNumericHistory?.current ? (
                  <div className="flex items-center justify-between gap-4">
                    <TelemetryValue
                      value={nonNumericHistory.current.value}
                      quality={nonNumericHistory.current.quality}
                      size="lg"
                    />
                    <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                      <span>Changed {formatRelativeTime(nonNumericHistory.current.timestamp)}</span>
                      <span className="text-border">|</span>
                      <span>{nonNumericHistory.sampleCount} samples in last 5m</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No history yet.</p>
                )}
              </div>

              {/* Recent state changes */}
              {selectedPropertyHistoryError ? (
                <div className="px-4 py-3">
                  <p className="text-sm text-red-400">
                    Failed to load history: {String(selectedPropertyHistoryError)}
                  </p>
                </div>
              ) : nonNumericHistory?.transitions.length ? (
                <div className="max-h-56 overflow-auto divide-y divide-border/40">
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
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
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

              {/* Value distribution */}
              {nonNumericHistory && nonNumericHistory.frequencies.length > 1 && (
                <div className="px-4 py-3 border-t border-border/50">
                  <div className="flex items-center gap-3">
                    <span className="text-[11px] uppercase tracking-wider text-muted-foreground shrink-0">
                      Distribution
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {nonNumericHistory.frequencies.map((entry) => (
                        <span
                          key={entry.value}
                          className="inline-flex items-center gap-1 rounded-full bg-accent/50 px-2 py-0.5 text-xs text-foreground"
                        >
                          <span className="font-medium">{entry.value}</span>
                          <span className="text-muted-foreground">x{entry.count}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Relationships ── */}
      {(relationships.length > 0 || relationshipsLoading) && (
        <RelationshipsBlock
          outgoing={outgoing}
          incoming={incoming}
          loading={relationshipsLoading}
          groupRelationships={groupRelationships}
          objectLookup={objectLookup}
          onSelectObject={(relatedId) => navigate(`/${relatedId}`)}
        />
      )}
    </div>
  )
}

// ── Property tile ──

function PropertyTile({
  propertyKey,
  value,
  isPrimary,
}: {
  propertyKey: string
  value: unknown
  isPrimary?: boolean
}) {
  const formatted = formatValue(value)
  const isComplex = value !== null && typeof value === "object"
  const isMonoFriendly =
    isPrimary || /^[a-z][a-z0-9_-]*$/i.test(formatted) || /^\d+$/.test(formatted)

  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-lg border bg-card/60 px-3 py-2.5 transition-colors",
        isPrimary
          ? "border-emerald-500/40 bg-emerald-500/5"
          : "border-border/50 hover:border-border"
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {humanizeIdentifier(propertyKey)}
        </span>
        {isPrimary && (
          <Badge
            variant="secondary"
            className="text-[9px] h-4 px-1.5 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-0"
          >
            id
          </Badge>
        )}
      </div>
      <span
        className={cn(
          "text-sm text-foreground break-words",
          isComplex ? "font-mono text-xs leading-relaxed" : "font-medium",
          isMonoFriendly && !isComplex && "font-mono"
        )}
        title={formatted}
      >
        {formatted}
      </span>
    </div>
  )
}

// ── Relationships block ──

function RelationshipsBlock({
  outgoing,
  incoming,
  loading,
  groupRelationships,
  objectLookup,
  onSelectObject,
}: {
  outgoing: RelationshipEdge[]
  incoming: RelationshipEdge[]
  loading: boolean
  groupRelationships: (edges: RelationshipEdge[]) => [string, RelationshipEdge[]][]
  objectLookup: Record<string, ObjectSummary>
  onSelectObject: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const total = outgoing.length + incoming.length

  const renderLink = (id: string, isLast: boolean) => {
    const related = objectLookup[id]
    return (
      <span key={id}>
        <button
          type="button"
          onClick={() => onSelectObject(id)}
          className="text-xs text-emerald-600 dark:text-emerald-400 hover:underline"
          title={id}
        >
          {related?.name ?? id}
        </button>
        {!isLast && <span className="text-muted-foreground/50 mx-1">·</span>}
      </span>
    )
  }

  return (
    <div className="rounded-xl border border-border/60 bg-card shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-2.5 flex items-center justify-between bg-muted/60 border-b border-border/50 hover:bg-muted/80 transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg
            className={cn(
              "w-3 h-3 text-muted-foreground transition-transform duration-200",
              expanded && "rotate-90"
            )}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Relationships
          </span>
          <Badge variant="secondary" className="text-[10px] bg-accent/70">
            {loading ? "..." : total}
          </Badge>
        </div>
      </button>

      {expanded && (
        <div className="p-4">
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground py-2">
              <div className="w-3.5 h-3.5 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" />
              <span className="text-xs">Loading...</span>
            </div>
          ) : (
            <div className="space-y-2">
              {groupRelationships(outgoing).map(([type, edges]) => (
                <div key={`out-${type}`} className="flex items-baseline gap-2 text-xs">
                  <span className="text-muted-foreground shrink-0">
                    {type.replace(/_/g, " ")} →
                  </span>
                  <span className="leading-relaxed">
                    {edges.map((edge, i) => renderLink(edge.target, i === edges.length - 1))}
                  </span>
                </div>
              ))}
              {groupRelationships(incoming).map(([type, edges]) => (
                <div key={`in-${type}`} className="flex items-baseline gap-2 text-xs">
                  <span className="text-muted-foreground shrink-0">
                    {type.replace(/_/g, " ")} ←
                  </span>
                  <span className="leading-relaxed">
                    {edges.map((edge, i) => renderLink(edge.source, i === edges.length - 1))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
