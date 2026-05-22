import type {
  ObjectAction,
  ObjectDetail,
  ObjectSummary,
  RelationshipEdge,
  TelemetryProperty,
} from "@pario/client"
import { useMemo, useState } from "react"
import { formatValue } from "../lib/formatValue"
import { cn } from "../lib/utils"
import { ActionButton } from "./ActionButton"
import { GlassCard } from "./common"
import { ObjectIcon } from "./ObjectIcon"
import { TelemetryGrid } from "./telemetry"
import { UsageBar } from "./UsageBar"
import { Badge } from "./ui/badge"

interface ObjectCardProps {
  object: ObjectDetail
  onSelectProperty: (propertyId: string) => void
  selectedPropertyId?: string | null
  latestTelemetryUpdates?: Record<string, LatestTelemetryUpdate>
  relationships?: RelationshipEdge[]
  relationshipsLoading?: boolean
  objectLookup?: Record<string, ObjectSummary>
  onSelectObject?: (objectId: string) => void
  compact?: boolean
}

interface LatestTelemetryUpdate {
  value: number | string | boolean
  quality?: "good" | "bad" | "uncertain"
}

interface ActionPresentation {
  tone: "default" | "primary" | "danger"
  featured: boolean
  requireConfirm: boolean
}

/**
 * Classify an action's visual presentation by matching its id/description against known keywords.
 *
 * If the action schema grows an explicit `danger` or `importance` field this heuristic should be
 * replaced with schema-driven classification.
 */
function getActionPresentation(actionId: string, _action: ObjectAction): ActionPresentation {
  // Only inspect the action id (kebab-case) — descriptions may contain incidental matches
  // like "Reset View" which shouldn't be flagged as dangerous.
  const id = actionId.toLowerCase()
  const has = (pattern: RegExp) => pattern.test(id)

  const dangerous =
    has(/^(power[-_ ]?off|shutdown|restart|reboot|factory[-_ ]?reset|erase|delete|remove|kill)$/) ||
    has(
      /[-_ ](power[-_ ]?off|shutdown|restart|reboot|factory[-_ ]?reset|erase|delete|remove|kill)$/
    )
  if (dangerous) {
    return {
      tone: "danger",
      featured: true,
      requireConfirm: true,
    }
  }

  const primary =
    has(
      /^(power[-_ ]?on|play|pause|resume|stop|launch|home|back|mute|unmute|volume[-_ ]?\w+|toggle[-_ ]?\w+)$/
    ) ||
    has(
      /[-_ ](power[-_ ]?on|play|pause|resume|stop|launch|home|back|mute|unmute|volume[-_ ]?\w+|toggle[-_ ]?\w+)$/
    )

  if (primary) {
    return {
      tone: "primary",
      featured: true,
      requireConfirm: false,
    }
  }

  return {
    tone: "default",
    featured: false,
    requireConfirm: false,
  }
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

export function ObjectCard({
  object,
  onSelectProperty,
  selectedPropertyId,
  latestTelemetryUpdates,
  relationships = [],
  relationshipsLoading = false,
  objectLookup,
  onSelectObject,
  compact = false,
}: ObjectCardProps) {
  const telemetryMap = (object.telemetry || {}) as Record<string, TelemetryProperty>
  const telemetryWithLive = Object.fromEntries(
    Object.entries(telemetryMap).map(([id, property]) => {
      const live = latestTelemetryUpdates?.[id]
      if (!live) return [id, property]
      return [
        id,
        {
          ...property,
          currentValue: live.value,
          quality: live.quality ?? property.quality,
        },
      ]
    })
  ) as Record<string, TelemetryProperty>
  const actions = Object.entries((object.actions as Record<string, ObjectAction> | undefined) || {})
  const actionsByPriority = useMemo(() => {
    const entries = Object.entries(
      (object.actions as Record<string, ObjectAction> | undefined) || {}
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
      const presentation = getActionPresentation(actionId, action)
      if (presentation.featured) {
        featured.push({ actionId, action, presentation })
      } else {
        regular.push({ actionId, action, presentation })
      }
    }

    return { featured, regular }
  }, [object.actions])
  const usagePercent = getUsagePercent(telemetryWithLive, object.class)
  const outgoing = relationships.filter(
    (relationship: RelationshipEdge) => relationship.source === object.id
  )
  const incoming = relationships.filter(
    (relationship: RelationshipEdge) => relationship.target === object.id
  )

  const groupRelationships = (edges: RelationshipEdge[]) => {
    const groups = new Map<string, RelationshipEdge[]>()
    for (const edge of edges) {
      const existing = groups.get(edge.type) ?? []
      existing.push(edge)
      groups.set(edge.type, existing)
    }
    return Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right))
  }

  const renderObjectLink = (relatedId: string, isLast: boolean) => {
    const related = objectLookup?.[relatedId]
    const labelText = related?.name ?? relatedId
    const canSelect = typeof onSelectObject === "function"
    return (
      <span key={relatedId}>
        <button
          type="button"
          onClick={() => onSelectObject?.(relatedId)}
          className={cn(
            "text-xs",
            canSelect
              ? "text-emerald-400 hover:text-emerald-300 hover:underline"
              : "text-muted-foreground cursor-default"
          )}
          title={relatedId}
          disabled={!canSelect}
        >
          {labelText}
        </button>
        {!isLast && <span className="text-muted-foreground/50 mx-1">·</span>}
      </span>
    )
  }

  return (
    <GlassCard
      padding="none"
      className="overflow-hidden motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500"
    >
      {/* Header */}
      <div className="px-5 py-4 border-b border-border/50">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-accent/50 rounded-xl text-foreground">
              <ObjectIcon type={object.class} />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground tracking-tight">
                {object.name || object.id}
              </h2>
              <p className="text-[11px] text-muted-foreground mt-0.5">{object.class}</p>
            </div>
          </div>
          {usagePercent !== null && (
            <div className="text-right">
              <p className="text-lg font-semibold text-foreground tracking-tight">
                {usagePercent.toFixed(0)}%
              </p>
            </div>
          )}
        </div>
        {usagePercent !== null && (
          <div className="mt-3">
            <UsageBar value={usagePercent} size="sm" />
          </div>
        )}
      </div>

      {/* Properties */}
      {object.properties && Object.keys(object.properties).length > 0 && (
        <div className="px-5 py-3 bg-accent/20 border-b border-border/50">
          <div className="flex flex-wrap gap-2">
            {Object.entries(object.properties).map(([key, value]) => (
              <span
                key={key}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-background/50 border border-border/50 text-muted-foreground"
              >
                {key}: {formatValue(value)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Telemetry Grid */}
      <div className="px-5 py-4">
        <TelemetryGrid
          telemetry={telemetryWithLive}
          selectedPropertyId={selectedPropertyId}
          onSelectProperty={onSelectProperty}
          latestUpdates={latestTelemetryUpdates}
          compact={compact}
        />
      </div>

      {/* Actions */}
      {actions.length > 0 && (
        <div className="border-t border-border/50">
          <div className="px-5 py-3 bg-accent/20 flex items-center gap-2">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Actions
            </p>
            <Badge
              variant="secondary"
              className="text-[9px] font-medium px-1.5 py-0 h-4 bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
            >
              {actions.length}
            </Badge>
          </div>
          <div className="px-5 py-4 space-y-3">
            {actionsByPriority.featured.length > 0 && (
              <div className="space-y-2">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Primary Controls
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {actionsByPriority.featured.map(({ actionId, action, presentation }) => (
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
              </div>
            )}

            {actionsByPriority.regular.length > 0 && (
              <div className="space-y-2">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  More Actions
                </p>
                <div className="flex flex-wrap gap-2">
                  {actionsByPriority.regular.map(({ actionId, action, presentation }) => (
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
              </div>
            )}
          </div>
        </div>
      )}

      {/* Relationships */}
      {(relationships.length > 0 || relationshipsLoading) && (
        <RelationshipsSection
          relationshipsLoading={relationshipsLoading}
          outgoing={outgoing}
          incoming={incoming}
          groupRelationships={groupRelationships}
          renderObjectLink={renderObjectLink}
        />
      )}
    </GlassCard>
  )
}

function RelationshipsSection({
  relationshipsLoading,
  outgoing,
  incoming,
  groupRelationships,
  renderObjectLink,
}: {
  relationshipsLoading: boolean
  outgoing: RelationshipEdge[]
  incoming: RelationshipEdge[]
  groupRelationships: (edges: RelationshipEdge[]) => [string, RelationshipEdge[]][]
  renderObjectLink: (relatedId: string, isLast: boolean) => React.ReactNode
}) {
  const [isExpanded, setIsExpanded] = useState(true)
  const totalCount = outgoing.length + incoming.length
  const relationshipCount = relationshipsLoading ? "..." : String(totalCount)

  const outgoingGroups = groupRelationships(outgoing)
  const incomingGroups = groupRelationships(incoming)

  return (
    <div className="border-t border-border/50">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-5 py-3 flex items-center justify-between text-left hover:bg-accent/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg
            className={cn(
              "w-3 h-3 text-muted-foreground transition-transform duration-200",
              isExpanded && "rotate-90"
            )}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Relationships
          </span>
          <span className="text-[10px] text-muted-foreground/70">({relationshipCount})</span>
        </div>
      </button>

      {isExpanded && (
        <div className="px-5 pb-4 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150">
          {relationshipsLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground py-2">
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span className="text-xs">Loading...</span>
            </div>
          ) : (
            <div className="space-y-2">
              {outgoingGroups.map(([type, edges]) => (
                <div key={`out-${type}`} className="flex items-baseline gap-2 text-xs">
                  <span className="text-muted-foreground shrink-0">
                    {type.replace(/_/g, " ")} →
                  </span>
                  <span className="leading-relaxed">
                    {edges.map((edge, i) => renderObjectLink(edge.target, i === edges.length - 1))}
                  </span>
                </div>
              ))}
              {incomingGroups.map(([type, edges]) => (
                <div key={`in-${type}`} className="flex items-baseline gap-2 text-xs">
                  <span className="text-muted-foreground shrink-0">
                    {type.replace(/_/g, " ")} ←
                  </span>
                  <span className="leading-relaxed">
                    {edges.map((edge, i) => renderObjectLink(edge.source, i === edges.length - 1))}
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
