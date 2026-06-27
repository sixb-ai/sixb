import type { ObjectSummary, TelemetryUpdate } from "@sixb/client"
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
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { Box, ChevronRight, Search } from "lucide-react"
import { type ReactNode, useDeferredValue, useEffect, useMemo, useState } from "react"
import { LetterAvatar, LoadingState } from "../components/common"
import { ObjectIcon } from "../components/ObjectIcon"
import { ObjectQueryBar, ObjectsQueryPagination } from "../components/objects/ObjectQueryBar"
import { formatCount } from "../lib/formatValue"
import { formatLocation, humanizeIdentifier } from "../lib/labels"
import {
  type AtlasObjectType,
  buildObjectQuery,
  executeAtlasObjectFacets,
  executeAtlasObjectQuery,
  getPropertyLabel,
  isFacetProperty,
  isFilterableProperty,
  isSortableProperty,
  type QueryFilter,
  type QueryMatchMode,
  type QueryProperty,
  type QuerySort,
} from "../lib/objects/objectQuery"
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
  objectPageSize: number
  allObjectsTotal: number
  objectTypeCounts: ReadonlyMap<string, number>
  overviewSections: ObjectTypePreviewSection[]
  overviewLoading: boolean
  objectTypesLoading?: boolean
  sortBy: ObjectSortPreference
  classFilter?: string | null
  selectedObjectType?: AtlasObjectType | null
  selectedObjectId?: string | null
  latestProjectUpdates: TelemetryUpdate[]
  onSortByChange: (sortBy: ObjectSortPreference) => void
  onClassFilterChange: (objectTypeId: string | null) => void
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

function formatLoadedCount(loaded: number, total: number | undefined): string {
  if (typeof total === "number" && total !== loaded) {
    return `${formatCount(loaded)} of ${formatCount(total)}`
  }
  return formatCount(total ?? loaded)
}

function objectMatchesQuery(candidate: ObjectSummary, query: string): boolean {
  const location = formatLocation(candidate.location).toLowerCase()
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
  objectPageSize,
  allObjectsTotal,
  objectTypeCounts,
  overviewSections,
  overviewLoading,
  objectTypesLoading = false,
  sortBy,
  classFilter,
  selectedObjectType,
  selectedObjectId,
  latestProjectUpdates,
  onSortByChange,
  onClassFilterChange,
  onSelectObject,
}: ObjectsWorkbenchProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const deferredSearchQuery = useDeferredValue(searchQuery)
  const [queryFilters, setQueryFilters] = useState<QueryFilter[]>([])
  const [queryMatchMode, setQueryMatchMode] = useState<QueryMatchMode>("all")
  const [querySort, setQuerySort] = useState<QuerySort | null>(null)
  const [viewStyle, setViewStyle] = useState<ViewStyle>(getObjectViewStyle)
  const selectedTypeMode = classFilter != null

  useEffect(() => {
    if (classFilter === undefined) return
    setSearchQuery("")
    setQueryFilters([])
    setQueryMatchMode("all")
    setQuerySort(null)
  }, [classFilter])

  const queryMode = selectedTypeMode && !!selectedObjectType
  const queryProperties = useMemo(
    () => (selectedObjectType?.properties ?? []) as QueryProperty[],
    [selectedObjectType]
  )
  const queryPropertiesById = useMemo(
    () => new Map(queryProperties.map((property) => [property.id, property])),
    [queryProperties]
  )
  const filterableProperties = useMemo(
    () => queryProperties.filter(isFilterableProperty),
    [queryProperties]
  )
  const sortableProperties = useMemo(
    () => queryProperties.filter(isSortableProperty),
    [queryProperties]
  )
  const facetProperties = useMemo(() => queryProperties.filter(isFacetProperty), [queryProperties])
  const textSearchEnabled = Boolean(selectedObjectType?.search?.defaultText?.length)

  const objectQuery = useMemo(() => {
    if (!queryMode || !classFilter) return null
    return buildObjectQuery({
      objectTypeId: classFilter,
      text: deferredSearchQuery,
      textSearchEnabled,
      filters: queryFilters,
      matchMode: queryMatchMode,
      sort: querySort,
    })
  }, [
    classFilter,
    deferredSearchQuery,
    queryFilters,
    queryMatchMode,
    queryMode,
    querySort,
    textSearchEnabled,
  ])

  const facetQuery = useMemo(() => {
    if (!queryMode || !classFilter) return null
    return buildObjectQuery({
      objectTypeId: classFilter,
      text: deferredSearchQuery,
      textSearchEnabled,
      filters: queryFilters,
      matchMode: queryMatchMode,
      sort: null,
    })
  }, [classFilter, deferredSearchQuery, queryFilters, queryMatchMode, queryMode, textSearchEnabled])

  const queriedObjects = useInfiniteQuery({
    queryKey: ["atlas", "objects", "query", objectQuery, objectPageSize],
    enabled: queryMode && !!objectQuery && !!selectedObjectType,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      executeAtlasObjectQuery(
        {
          kind: "page",
          input: objectQuery!,
          pageSize: objectPageSize,
          pageToken: pageParam,
        },
        selectedObjectType!
      ),
    getNextPageParam: (lastPage) => lastPage.nextPageToken,
    retry: false,
  })

  const facetRequests = useMemo(
    () => facetProperties.slice(0, 4).map((property) => ({ propertyId: property.id, limit: 8 })),
    [facetProperties]
  )

  const facetsQuery = useQuery({
    queryKey: ["atlas", "objects", "facets", facetQuery, facetRequests],
    enabled: queryMode && !!facetQuery && facetRequests.length > 0,
    queryFn: () => executeAtlasObjectFacets(facetQuery!, facetRequests),
    retry: false,
  })

  const queryObjectsPage = useMemo(
    () => queriedObjects.data?.pages.flatMap((page) => page.objects) ?? [],
    [queriedObjects.data]
  )
  const queryTotal = queriedObjects.data?.pages[0]?.total ?? queryObjectsPage.length

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
    if (queryMode) return queryObjectsPage
    if (selectedTypeMode) return []
    const query = searchQuery.trim().toLowerCase()
    const overviewObjects = overviewSections.flatMap((section) => section.objects)
    if (!query) return overviewObjects
    return overviewObjects.filter((candidate) => objectMatchesQuery(candidate, query))
  }, [overviewSections, queryMode, queryObjectsPage, selectedTypeMode, searchQuery])

  const filteredOverviewSections = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return overviewSections

    return overviewSections
      .map((section) => ({
        ...section,
        objects: section.objects.filter((candidate) => objectMatchesQuery(candidate, query)),
      }))
      .filter(
        (section) =>
          section.objects.length > 0 ||
          humanizeIdentifier(section.objectTypeId).toLowerCase().includes(query) ||
          section.objectTypeId.toLowerCase().includes(query)
      )
  }, [overviewSections, searchQuery])

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

  const searching = queryMode
    ? searchQuery.trim().length > 0 || queryFilters.length > 0
    : searchQuery.trim().length > 0
  const visibleObjectCount = selectedTypeMode
    ? filteredObjects.length
    : filteredOverviewSections.reduce((total, section) => total + section.objects.length, 0)
  const headerCount = queryMode
    ? queryTotal
    : searching
      ? visibleObjectCount
      : selectedTypeMode
        ? 0
        : allObjectsTotal
  const pageLoading = queryMode
    ? queriedObjects.isLoading
    : selectedTypeMode && !selectedObjectType
      ? objectTypesLoading
      : overviewLoading
  const hasResults = selectedTypeMode
    ? filteredObjects.length > 0
    : filteredOverviewSections.some((section) => section.objects.length > 0)
  const queryError = queriedObjects.error ?? facetsQuery.error
  const querySortValue = querySort ? `${querySort.propertyId}:${querySort.direction}` : "default"

  return (
    <div className="mx-auto w-full max-w-5xl">
      <CollectionHeader
        title="Objects"
        count={headerCount}
        actions={
          <div className="flex items-center gap-2">
            {queryMode ? (
              <Select
                value={querySortValue}
                disabled={sortableProperties.length === 0}
                onValueChange={(value) => {
                  if (value === "default") {
                    setQuerySort(null)
                    return
                  }

                  const separator = value.lastIndexOf(":")
                  const direction = value.slice(separator + 1)
                  if (separator > 0 && (direction === "asc" || direction === "desc")) {
                    setQuerySort({ propertyId: value.slice(0, separator), direction })
                  }
                }}
              >
                <SelectTrigger size="sm" className="h-8 w-36 text-xs" aria-label="Sort objects">
                  <SelectValue placeholder="Sort" />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="default">Default order</SelectItem>
                  {sortableProperties.map((property) => (
                    <SelectItem key={`${property.id}:asc`} value={`${property.id}:asc`}>
                      {getPropertyLabel(property)} asc
                    </SelectItem>
                  ))}
                  {sortableProperties.map((property) => (
                    <SelectItem key={`${property.id}:desc`} value={`${property.id}:desc`}>
                      {getPropertyLabel(property)} desc
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
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
            )}
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

      {queryMode && selectedObjectType ? (
        <ObjectQueryBar
          objectType={selectedObjectType}
          searchQuery={searchQuery}
          textSearchEnabled={textSearchEnabled}
          filters={queryFilters}
          matchMode={queryMatchMode}
          filterableProperties={filterableProperties}
          propertiesById={queryPropertiesById}
          facetResults={facetsQuery.data ?? []}
          facetsLoading={facetsQuery.isLoading}
          queryError={queryError}
          onSearchQueryChange={setSearchQuery}
          onAddFilter={(filter) => setQueryFilters((current) => [...current, filter])}
          onRemoveFilter={(filterId) =>
            setQueryFilters((current) => current.filter((filter) => filter.id !== filterId))
          }
          onClear={() => {
            setSearchQuery("")
            setQueryFilters([])
          }}
          onMatchModeChange={setQueryMatchMode}
        />
      ) : (
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
      )}

      <div className="mt-4 space-y-4">
        {pageLoading ? (
          <div className="flex min-h-72 items-center justify-center">
            <LoadingState label="Loading objects..." />
          </div>
        ) : !hasResults ? (
          <EmptyState
            icon={<Box className="size-12 stroke-1" />}
            title="No matching objects"
            description={
              queryMode
                ? "Try removing filters or broadening the search."
                : "Try a broader search query."
            }
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
                  queryMode
                    ? queryTotal
                    : searching
                      ? undefined
                      : className === classFilter
                        ? queryTotal
                        : objectTypeCounts.get(className)
                )}
                selectedObjectId={selectedObjectId}
                onSelectObject={handleSelectObject}
              />
            ))}
          </div>
        )}
        {queryMode && hasResults ? (
          <ObjectsQueryPagination
            loadedCount={queryObjectsPage.length}
            total={queryTotal}
            hasMore={queriedObjects.hasNextPage}
            loadingMore={queriedObjects.isFetchingNextPage}
            onLoadMore={() => queriedObjects.fetchNextPage()}
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
  updatesByObject,
  selectedObjectId,
  onSelectObject,
}: {
  objects: ObjectSummary[]
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
            const location = formatLocation(object.location)
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
