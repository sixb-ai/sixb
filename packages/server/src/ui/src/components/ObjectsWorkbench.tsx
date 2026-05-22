import type { ObjectDetail, ObjectSummary } from "@pario/client"
import { getObjectOptions } from "@pario/client/hooks"
import {
  Card,
  CollectionCardButton,
  CollectionCardGrid,
  CollectionHeader,
  CollectionViewToggle,
  EmptyState,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@pario/ui/components"
import { cn } from "@pario/ui/lib/utils"
import { useQueries } from "@tanstack/react-query"
import { Box, Search } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import type { TelemetryUpdate } from "../hooks/useWebSocket"
import { formatLocation, humanizeIdentifier } from "../lib/labels"
import { formatRelativeTime } from "../lib/time"
import {
  getObjectViewStyle,
  type ObjectSortPreference,
  setObjectViewStyle,
  trackRecentObject,
} from "../lib/userPreferences"
import { LetterAvatar, LoadingState } from "./common"
import { ObjectIcon } from "./ObjectIcon"

interface ObjectsWorkbenchProps {
  projectName: string
  objects: ObjectSummary[]
  loading: boolean
  sortBy: ObjectSortPreference
  selectedObjectId?: string | null
  latestProjectUpdates: TelemetryUpdate[]
  onSortByChange: (sortBy: ObjectSortPreference) => void
  onSelectObject: (id: string) => void
}

type ViewStyle = "cards" | "table"
const objectViewOptions = [
  { value: "cards", label: "Cards" },
  { value: "table", label: "Table" },
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
  sortBy,
  selectedObjectId,
  latestProjectUpdates,
  onSortByChange,
  onSelectObject,
}: ObjectsWorkbenchProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [viewStyle, setViewStyle] = useState<ViewStyle>(getObjectViewStyle)
  const [searchParams, setSearchParams] = useSearchParams()
  const classFilter = searchParams.get("class")

  const setClassFilter = useCallback(
    (next: string | null) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          if (next) {
            params.set("class", next)
          } else {
            params.delete("class")
          }
          return params
        },
        { replace: true }
      )
    },
    [setSearchParams]
  )

  const detailQueries = useQueries({
    queries: objects.map((object) => ({
      ...getObjectOptions({
        path: { projectName, objectId: object.id },
      }),
      enabled: !!projectName,
      retry: false,
    })),
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

  const classCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const obj of objects) {
      counts.set(obj.class, (counts.get(obj.class) ?? 0) + 1)
    }
    return counts
  }, [objects])

  const availableClasses = useMemo(
    () =>
      Array.from(classCounts.keys()).sort((a, b) =>
        humanizeIdentifier(a).localeCompare(humanizeIdentifier(b))
      ),
    [classCounts]
  )

  // Reset filter if the active class disappears from the dataset.
  useEffect(() => {
    if (!loading && classFilter && !classCounts.has(classFilter)) {
      setClassFilter(null)
    }
  }, [classFilter, classCounts, loading, setClassFilter])

  const filteredObjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    const result = classFilter ? objects.filter((obj) => obj.class === classFilter) : objects
    if (!query) return result
    return result.filter((candidate) => {
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
  }, [objects, classFilter, searchQuery, detailById])

  const groups = useMemo(() => {
    const grouped = new Map<string, ObjectSummary[]>()
    for (const obj of filteredObjects) {
      const list = grouped.get(obj.class) ?? []
      list.push(obj)
      grouped.set(obj.class, list)
    }
    return Array.from(grouped.entries()).sort(([a], [b]) =>
      humanizeIdentifier(a).localeCompare(humanizeIdentifier(b))
    )
  }, [filteredObjects])

  const handleSelectObject = (objectId: string) => {
    trackRecentObject(projectName, objectId)
    onSelectObject(objectId)
  }

  return (
    <div className="mx-auto w-full max-w-5xl">
      <CollectionHeader
        title="Objects"
        count={filteredObjects.length}
        actions={
          <div className="flex items-center gap-2">
            <Select
              value={sortBy}
              onValueChange={(value) => {
                if (value === "primaryId" || value === "updatedAt") {
                  onSortByChange(value)
                }
              }}
            >
              <SelectTrigger size="sm" className="h-8 w-28 text-xs" aria-label="Sort objects">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="primaryId">Primary ID</SelectItem>
                <SelectItem value="updatedAt">Updated at</SelectItem>
              </SelectContent>
            </Select>
            <CollectionViewToggle
              value={viewStyle}
              options={objectViewOptions}
              onChange={(style) => {
                setViewStyle(style)
                setObjectViewStyle(style)
              }}
            />
          </div>
        }
      />

      {availableClasses.length > 1 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <ClassChip
            label="All"
            count={objects.length}
            active={classFilter === null}
            onClick={() => setClassFilter(null)}
          />
          {availableClasses.map((cls) => (
            <ClassChip
              key={cls}
              label={humanizeIdentifier(cls)}
              count={classCounts.get(cls) ?? 0}
              active={classFilter === cls}
              onClick={() => setClassFilter(cls)}
            />
          ))}
        </div>
      ) : null}

      <div className="relative mt-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Search objects, location, or class..."
          className="pl-9"
        />
      </div>

      <div className="mt-4">
        {loading ? (
          <div className="flex min-h-72 items-center justify-center">
            <LoadingState label="Loading objects..." />
          </div>
        ) : filteredObjects.length === 0 ? (
          <EmptyState
            icon={<Box className="size-12 stroke-1" />}
            title="No matching objects"
            description="Try a broader search query."
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
          <div className="space-y-6">
            {groups.map(([className, items]) => (
              <section key={className} className="space-y-2">
                <div className="sticky top-0 z-10 -mx-1 flex items-baseline gap-2 bg-background/95 px-1 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-background/80">
                  <LetterAvatar label={humanizeIdentifier(className)} />
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
                    {humanizeIdentifier(className)}
                  </h3>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    · {items.length}
                  </span>
                </div>
                <CollectionCardGrid>
                  {items.map((candidate) => (
                    <ObjectCardItem
                      key={candidate.id}
                      object={candidate}
                      isActive={selectedObjectId === candidate.id}
                      onSelect={() => handleSelectObject(candidate.id)}
                    />
                  ))}
                </CollectionCardGrid>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ClassChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors",
        active
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-card text-foreground hover:bg-muted"
      )}
    >
      <span>{label}</span>
      <span className={cn("tabular-nums", active ? "text-background/70" : "text-muted-foreground")}>
        {count}
      </span>
    </button>
  )
}

function ObjectCardItem({
  object,
  isActive,
  onSelect,
}: {
  object: ObjectSummary
  isActive: boolean
  onSelect: () => void
}) {
  const label = object.name || humanizeIdentifier(object.id)
  return (
    <CollectionCardButton onClick={onSelect} active={isActive}>
      <LetterAvatar label={label} size="sm" />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{label}</p>
      </div>
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
    <Card className="overflow-hidden p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead className="hidden sm:table-cell">Class</TableHead>
            <TableHead className="hidden sm:table-cell">Location</TableHead>
            <TableHead className="hidden md:table-cell">Updated</TableHead>
            <TableHead className="hidden lg:table-cell">Key Signal</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {objects.map((object) => {
            const updates = updatesByObject.get(object.id) ?? []
            const detail = detailById.get(object.id)
            const location = formatLocation(detail?.location)
            const keySignal = updates[0]
            const isActive = selectedObjectId === object.id

            return (
              <TableRow
                key={object.id}
                onClick={() => onSelectObject(object.id)}
                data-state={isActive ? "selected" : undefined}
                className="cursor-pointer"
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    <ObjectIcon type={object.class} className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="truncate text-sm font-medium text-foreground">
                      {object.name || humanizeIdentifier(object.id)}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                  {humanizeIdentifier(object.class)}
                </TableCell>
                <TableCell className="hidden sm:table-cell">
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
                </TableCell>
                <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                  {formatRelativeTime(object.updatedAt)}
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  {keySignal ? (
                    <span className="text-xs text-foreground">
                      {humanizeIdentifier(keySignal.propertyId)}:{" "}
                      <span className="font-medium">{formatCompactValue(keySignal.value)}</span>
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground/40">—</span>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Card>
  )
}
