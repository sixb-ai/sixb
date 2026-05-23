import type { ObjectDetail, ObjectSummary } from "@sixb/client"
import { getObjectOptions } from "@sixb/client/hooks"
import {
  Button,
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
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useQueries } from "@tanstack/react-query"
import { Box, ChevronLeft, ChevronRight, Search } from "lucide-react"
import { type ReactNode, useMemo, useState } from "react"
import { LetterAvatar, LoadingState } from "../components/common"
import { ObjectIcon } from "../components/ObjectIcon"
import { formatLocation, humanizeIdentifier } from "../lib/labels"
import type { TelemetryUpdate } from "../lib/telemetryEvents"
import { formatRelativeTime } from "../lib/time"
import {
  getObjectViewStyle,
  type ObjectSortPreference,
  setObjectViewStyle,
  trackRecentObject,
} from "../lib/userPreferences"

export interface ObjectTypePreviewSection {
  objectTypeId: string
  objects: ObjectSummary[]
  total: number
}

interface ObjectsWorkbenchProps {
  projectName: string
  objects: ObjectSummary[]
  objectsTotal: number
  objectsHasMore: boolean
  objectOffset: number
  objectPageSize: number
  allObjectsTotal: number
  objectTypeCounts: ReadonlyMap<string, number>
  overviewSections: ObjectTypePreviewSection[]
  overviewLoading: boolean
  loading: boolean
  sortBy: ObjectSortPreference
  classFilter?: string | null
  selectedObjectId?: string | null
  latestProjectUpdates: TelemetryUpdate[]
  onSortByChange: (sortBy: ObjectSortPreference) => void
  onClassFilterChange: (objectTypeId: string | null, offset?: number) => void
  onObjectOffsetChange: (offset: number) => void
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

function formatCount(value: number): string {
  return value.toLocaleString()
}

function formatLoadedCount(loaded: number, total: number | undefined): string {
  if (typeof total === "number" && total !== loaded) {
    return `${formatCount(loaded)} of ${formatCount(total)}`
  }
  return formatCount(total ?? loaded)
}

function objectMatchesQuery(
  candidate: ObjectSummary,
  query: string,
  details: ReadonlyMap<string, ObjectDetail>
): boolean {
  const detail = details.get(candidate.id)
  const location = formatLocation(detail?.location).toLowerCase()
  const name = (candidate.name || "").toLowerCase()
  const className = humanizeIdentifier(candidate.class).toLowerCase()
  return (
    candidate.id.toLowerCase().includes(query) ||
    candidate.class.toLowerCase().includes(query) ||
    className.includes(query) ||
    name.includes(query) ||
    location.includes(query)
  )
}

export function ObjectsWorkbench({
  projectName,
  objects,
  objectsTotal,
  objectsHasMore,
  objectOffset,
  objectPageSize,
  allObjectsTotal,
  objectTypeCounts,
  overviewSections,
  overviewLoading,
  loading,
  sortBy,
  classFilter,
  selectedObjectId,
  latestProjectUpdates,
  onSortByChange,
  onClassFilterChange,
  onObjectOffsetChange,
  onSelectObject,
}: ObjectsWorkbenchProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [viewStyle, setViewStyle] = useState<ViewStyle>(getObjectViewStyle)
  const selectedTypeMode = classFilter != null

  const displayObjects = useMemo(
    () => (selectedTypeMode ? objects : overviewSections.flatMap((section) => section.objects)),
    [objects, overviewSections, selectedTypeMode]
  )

  const detailQueries = useQueries({
    queries: displayObjects.map((object) => ({
      ...getObjectOptions({
        path: { projectName, objectId: object.id },
      }),
      enabled: !!projectName,
      retry: false,
    })),
  })

  const detailById = useMemo(() => {
    const detailMap = new Map<string, ObjectDetail>()
    for (let i = 0; i < displayObjects.length; i += 1) {
      const detail = detailQueries[i]?.data as ObjectDetail | undefined
      if (detail) detailMap.set(displayObjects[i].id, detail)
    }
    return detailMap
  }, [displayObjects, detailQueries])

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

  const availableClasses = useMemo(
    () =>
      Array.from(objectTypeCounts.entries())
        .filter(([className, count]) => count > 0 || className === classFilter)
        .map(([className]) => className)
        .sort((a, b) => humanizeIdentifier(a).localeCompare(humanizeIdentifier(b))),
    [objectTypeCounts, classFilter]
  )

  const filteredObjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return objects
    return objects.filter((candidate) => objectMatchesQuery(candidate, query, detailById))
  }, [objects, searchQuery, detailById])

  const filteredOverviewSections = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return overviewSections

    return overviewSections
      .map((section) => ({
        ...section,
        objects: section.objects.filter((candidate) =>
          objectMatchesQuery(candidate, query, detailById)
        ),
      }))
      .filter(
        (section) =>
          section.objects.length > 0 ||
          humanizeIdentifier(section.objectTypeId).toLowerCase().includes(query) ||
          section.objectTypeId.toLowerCase().includes(query)
      )
  }, [overviewSections, searchQuery, detailById])

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

  const searching = searchQuery.trim().length > 0
  const visibleObjectCount = selectedTypeMode
    ? filteredObjects.length
    : filteredOverviewSections.reduce((total, section) => total + section.objects.length, 0)
  const headerCount = searching
    ? visibleObjectCount
    : selectedTypeMode
      ? objectsTotal
      : allObjectsTotal
  const pageLoading = selectedTypeMode ? loading : overviewLoading
  const showPagination =
    selectedTypeMode && !loading && (objectsTotal > objectPageSize || objectOffset > 0)
  const hasResults = selectedTypeMode
    ? filteredObjects.length > 0
    : filteredOverviewSections.some((section) => section.objects.length > 0)

  return (
    <div className="mx-auto w-full max-w-5xl">
      <CollectionHeader
        title="Objects"
        count={headerCount}
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
            {selectedTypeMode ? (
              <CollectionViewToggle
                value={viewStyle}
                options={objectViewOptions}
                onChange={(style) => {
                  setViewStyle(style)
                  setObjectViewStyle(style)
                }}
              />
            ) : null}
          </div>
        }
      />

      {availableClasses.length > 1 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <ClassChip
            label="All"
            count={allObjectsTotal}
            active={classFilter == null}
            onClick={() => onClassFilterChange(null)}
          />
          {availableClasses.map((cls) => (
            <ClassChip
              key={cls}
              label={humanizeIdentifier(cls)}
              count={objectTypeCounts.get(cls) ?? 0}
              active={classFilter === cls}
              onClick={() => onClassFilterChange(cls)}
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

      <div className="mt-4 space-y-4">
        {pageLoading ? (
          <div className="flex min-h-72 items-center justify-center">
            <LoadingState label="Loading objects..." />
          </div>
        ) : !hasResults ? (
          <EmptyState
            icon={<Box className="size-12 stroke-1" />}
            title="No matching objects"
            description="Try a broader search query."
          />
        ) : !selectedTypeMode ? (
          <div className="space-y-6">
            {filteredOverviewSections.map((section) => (
              <ObjectCardSection
                key={section.objectTypeId}
                objectTypeId={section.objectTypeId}
                objects={section.objects}
                count={formatLoadedCount(
                  section.objects.length,
                  searching ? undefined : section.total
                )}
                selectedObjectId={selectedObjectId}
                onSelectObject={handleSelectObject}
                action={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-7 px-2 text-xs"
                    title={`View ${humanizeIdentifier(section.objectTypeId)} objects`}
                    onClick={() => onClassFilterChange(section.objectTypeId)}
                  >
                    View all
                    <ChevronRight />
                  </Button>
                }
              />
            ))}
          </div>
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
              <ObjectCardSection
                key={className}
                objectTypeId={className}
                objects={items}
                count={formatLoadedCount(
                  items.length,
                  searching
                    ? undefined
                    : className === classFilter
                      ? objectsTotal
                      : objectTypeCounts.get(className)
                )}
                selectedObjectId={selectedObjectId}
                onSelectObject={handleSelectObject}
              />
            ))}
          </div>
        )}
        {showPagination ? (
          <ObjectsPagination
            offset={objectOffset}
            pageSize={objectPageSize}
            total={objectsTotal}
            loadedCount={objects.length}
            visibleCount={filteredObjects.length}
            hasMore={objectsHasMore}
            searching={searching}
            onOffsetChange={onObjectOffsetChange}
          />
        ) : null}
      </div>
    </div>
  )
}

function ObjectCardSection({
  objectTypeId,
  objects,
  count,
  selectedObjectId,
  action,
  onSelectObject,
}: {
  objectTypeId: string
  objects: ObjectSummary[]
  count: string
  selectedObjectId?: string | null
  action?: ReactNode
  onSelectObject: (id: string) => void
}) {
  const label = humanizeIdentifier(objectTypeId)

  return (
    <section className="space-y-2">
      <div className="sticky top-0 z-10 -mx-1 flex items-baseline gap-2 bg-background/95 px-1 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <LetterAvatar label={label} />
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
          {label}
        </h3>
        <span className="text-[11px] text-muted-foreground tabular-nums">· {count}</span>
        {action}
      </div>
      <CollectionCardGrid>
        {objects.map((candidate) => (
          <ObjectCardItem
            key={candidate.id}
            object={candidate}
            isActive={selectedObjectId === candidate.id}
            onSelect={() => onSelectObject(candidate.id)}
          />
        ))}
      </CollectionCardGrid>
    </section>
  )
}

function ObjectsPagination({
  offset,
  pageSize,
  total,
  loadedCount,
  visibleCount,
  hasMore,
  searching,
  onOffsetChange,
}: {
  offset: number
  pageSize: number
  total: number
  loadedCount: number
  visibleCount: number
  hasMore: boolean
  searching: boolean
  onOffsetChange: (offset: number) => void
}) {
  const rangeStart = loadedCount > 0 ? offset + 1 : 0
  const rangeEnd = loadedCount > 0 ? offset + loadedCount : 0
  const canGoBack = offset > 0
  const canGoForward = hasMore

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs tabular-nums text-muted-foreground">
        Showing {formatCount(rangeStart)}-{formatCount(rangeEnd)} of {formatCount(total)}
        {searching ? ` · ${formatCount(visibleCount)} matching this page` : ""}
      </p>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canGoBack}
          onClick={() => onOffsetChange(Math.max(0, offset - pageSize))}
        >
          <ChevronLeft />
          Previous
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canGoForward}
          onClick={() => onOffsetChange(offset + pageSize)}
        >
          Next
          <ChevronRight />
        </Button>
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
        {formatCount(count)}
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
