import type { ObjectDetail, ObjectSummary } from "@pario/client"
import { getObjectOptions, listRelationshipsOptions } from "@pario/client/hooks"
import { useQueries, useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import type { TelemetryUpdate } from "../hooks/useWebSocket"
import { formatLocation, humanizeIdentifier } from "../lib/labels"
import { formatRelativeTime } from "../lib/time"
import {
  getFavoriteObjectIds,
  getObjectViewStyle,
  setObjectViewStyle,
  toggleFavoriteObject,
  trackRecentObject,
} from "../lib/userPreferences"
import { cn } from "../lib/utils"
import {
  CollectionCardButton,
  CollectionCardGrid,
  CollectionHeader,
  CollectionTable,
  CollectionViewToggle,
  EmptyState,
  EmptyStateIcons,
  LoadingSpinner,
  SearchInput,
} from "./common"
import { ObjectGraphView } from "./ObjectGraphView"
import { ObjectIcon } from "./ObjectIcon"

interface ObjectsWorkbenchProps {
  projectName: string
  objects: ObjectSummary[]
  loading: boolean
  selectedObjectId?: string | null
  latestProjectUpdates: TelemetryUpdate[]
  onSelectObject: (id: string) => void
}

type ViewStyle = "cards" | "table" | "graph"
const objectViewOptions = [
  { value: "cards", label: "Cards" },
  { value: "table", label: "Table" },
  { value: "graph", label: "Graph" },
] as const

function formatCompactValue(value: number | string | boolean): string {
  if (typeof value === "number") {
    if (Math.abs(value) >= 1000) return value.toFixed(0)
    return value.toFixed(1)
  }
  if (typeof value === "boolean") return value ? "On" : "Off"
  return value
}

export function ObjectsWorkbench({
  projectName,
  objects,
  loading,
  selectedObjectId,
  latestProjectUpdates,
  onSelectObject,
}: ObjectsWorkbenchProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [favoriteIds, setFavoriteIds] = useState<string[]>([])
  const [viewStyle, setViewStyle] = useState<ViewStyle>(getObjectViewStyle)

  useEffect(() => {
    setFavoriteIds(getFavoriteObjectIds(projectName))
  }, [projectName])

  const detailQueries = useQueries({
    queries: objects.map((object) => ({
      ...getObjectOptions({
        path: { projectName, objectId: object.id },
      }),
      enabled: !!projectName,
      retry: false,
    })),
  })

  const { data: relationships = [] } = useQuery({
    ...listRelationshipsOptions({
      path: { projectName },
    }),
    enabled: !!projectName,
  })

  const detailById = useMemo(() => {
    const detailMap = new Map<string, ObjectDetail>()
    for (let i = 0; i < objects.length; i += 1) {
      const detail = detailQueries[i]?.data as ObjectDetail | undefined
      if (detail) detailMap.set(objects[i].id, detail)
    }
    return detailMap
  }, [objects, detailQueries])

  const updatesByObject = useMemo(() => {
    const grouped = new Map<string, TelemetryUpdate[]>()
    for (const update of latestProjectUpdates) {
      const existing = grouped.get(update.objectId) ?? []
      existing.push(update)
      grouped.set(update.objectId, existing)
    }
    for (const entry of grouped.values()) {
      entry.sort((left, right) => +new Date(right.timestamp) - +new Date(left.timestamp))
    }
    return grouped
  }, [latestProjectUpdates])

  const filteredObjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return objects

    return objects.filter((candidate) => {
      const detail = detailById.get(candidate.id)
      const location = formatLocation(detail?.location).toLowerCase()
      const name = (candidate.name || "").toLowerCase()
      return (
        candidate.id.toLowerCase().includes(query) ||
        candidate.class.toLowerCase().includes(query) ||
        name.includes(query) ||
        location.includes(query)
      )
    })
  }, [objects, searchQuery, detailById])

  const favoriteSet = useMemo(() => new Set(favoriteIds), [favoriteIds])

  const handleSelectObject = (objectId: string) => {
    trackRecentObject(projectName, objectId)
    onSelectObject(objectId)
  }

  const toggleFavorite = (objectId: string) => {
    setFavoriteIds(toggleFavoriteObject(projectName, objectId))
  }

  return (
    <div>
      <CollectionHeader
        title="Objects"
        count={filteredObjects.length}
        actions={
          <CollectionViewToggle
            value={viewStyle}
            options={objectViewOptions}
            onChange={(style) => {
              setViewStyle(style)
              setObjectViewStyle(style)
            }}
          />
        }
      />

      <SearchInput
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder="Search objects, location, or class..."
        className="mt-2"
      />

      <div className="mt-4">
        {loading ? (
          <div className="flex min-h-72 items-center justify-center">
            <LoadingSpinner text="Loading objects..." />
          </div>
        ) : filteredObjects.length === 0 ? (
          <EmptyState
            icon={EmptyStateIcons.cube}
            title="No matching objects"
            description="Try a broader search query."
          />
        ) : viewStyle === "graph" ? (
          <ObjectGraphView
            objects={filteredObjects}
            relationships={relationships}
            selectedObjectId={selectedObjectId ?? null}
            onSelectObject={handleSelectObject}
          />
        ) : viewStyle === "table" ? (
          <TableView
            objects={filteredObjects}
            detailById={detailById}
            updatesByObject={updatesByObject}
            selectedObjectId={selectedObjectId ?? null}
            onSelectObject={handleSelectObject}
          />
        ) : (
          <CollectionCardGrid>
            {filteredObjects.map((candidate) => (
              <ObjectCardItem
                key={candidate.id}
                object={candidate}
                isActive={selectedObjectId === candidate.id}
                isFavorite={favoriteSet.has(candidate.id)}
                onSelect={() => handleSelectObject(candidate.id)}
                onToggleFavorite={() => toggleFavorite(candidate.id)}
              />
            ))}
          </CollectionCardGrid>
        )}
      </div>
    </div>
  )
}

function ObjectCardItem({
  object,
  isActive,
  isFavorite,
  onSelect,
  onToggleFavorite,
}: {
  object: ObjectSummary
  isActive: boolean
  isFavorite: boolean
  onSelect: () => void
  onToggleFavorite: () => void
}) {
  return (
    <CollectionCardButton onClick={onSelect} active={isActive}>
      <div className="rounded-lg bg-accent/60 p-1.5 text-foreground">
        <ObjectIcon type={object.class} className="h-4 w-4" />
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {object.name || humanizeIdentifier(object.id)}
        </p>
        <p className="truncate text-[11px] text-muted-foreground">
          {humanizeIdentifier(object.class)}
        </p>
      </div>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onToggleFavorite()
        }}
        className={cn(
          "shrink-0 rounded-md p-1 text-xs transition-colors",
          isFavorite
            ? "text-amber-400 hover:text-amber-300"
            : "text-muted-foreground/30 hover:text-muted-foreground"
        )}
        aria-label={isFavorite ? "Unpin favorite" : "Pin favorite"}
      >
        ★
      </button>
    </CollectionCardButton>
  )
}

function TableView({
  objects,
  detailById,
  updatesByObject,
  selectedObjectId,
  onSelectObject,
}: {
  objects: ObjectSummary[]
  detailById: Map<string, ObjectDetail>
  updatesByObject: Map<string, TelemetryUpdate[]>
  selectedObjectId: string | null
  onSelectObject: (id: string) => void
}) {
  return (
    <CollectionTable>
      <thead>
        <tr className="border-b border-border/50 bg-muted text-xs text-muted-foreground">
          <th className="py-2 pl-3 pr-3 font-medium">Name</th>
          <th className="hidden px-3 py-2 font-medium sm:table-cell">Class</th>
          <th className="hidden px-3 py-2 font-medium sm:table-cell">Location</th>
          <th className="hidden px-3 py-2 font-medium md:table-cell">Updated</th>
          <th className="hidden px-3 py-2 font-medium lg:table-cell">Key Signal</th>
        </tr>
      </thead>
      <tbody className="bg-card">
        {objects.map((object, index) => {
          const updates = updatesByObject.get(object.id) ?? []
          const detail = detailById.get(object.id)
          const location = formatLocation(detail?.location)
          const keySignal = updates[0]
          const isActive = selectedObjectId === object.id

          return (
            <tr
              key={object.id}
              onClick={() => onSelectObject(object.id)}
              className={cn(
                "cursor-pointer transition-colors hover:bg-muted/30",
                index !== objects.length - 1 && "border-b border-border/40",
                isActive && "bg-emerald-500/5"
              )}
            >
              <td className="py-2 pl-3 pr-3">
                <div className="flex items-center gap-2">
                  <ObjectIcon type={object.class} className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="truncate font-medium text-foreground">
                    {object.name || humanizeIdentifier(object.id)}
                  </span>
                </div>
              </td>
              <td className="hidden px-3 py-2 text-xs text-muted-foreground sm:table-cell">
                {humanizeIdentifier(object.class)}
              </td>
              <td className="hidden px-3 py-2 sm:table-cell">
                <span
                  className={cn(
                    "truncate text-xs",
                    location === "No location set"
                      ? "text-muted-foreground/40"
                      : "text-muted-foreground"
                  )}
                >
                  {location === "No location set" ? "—" : location}
                </span>
              </td>
              <td className="hidden px-3 py-2 text-xs text-muted-foreground md:table-cell">
                {formatRelativeTime(object.updatedAt)}
              </td>
              <td className="hidden px-3 py-2 lg:table-cell">
                {keySignal ? (
                  <span className="text-xs text-foreground">
                    {humanizeIdentifier(keySignal.propertyId)}:{" "}
                    <span className="font-medium">{formatCompactValue(keySignal.value)}</span>
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground/40">—</span>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </CollectionTable>
  )
}
