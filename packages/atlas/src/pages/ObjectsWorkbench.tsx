import type { ObjectSummary, TelemetryUpdate } from "@sixb/client"
import {
  Button,
  Card,
  CollectionCardButton,
  CollectionCardGrid,
  CollectionViewToggle,
  EmptyState,
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
import { ArrowRight, Box, ChevronRight, X } from "lucide-react"
import { type ReactNode, useDeferredValue, useEffect, useMemo, useState } from "react"
import { CollectionPageTitle, CollectionSearchInput } from "../components/CollectionPageHeader"
import { LetterAvatar, LoadingState } from "../components/common"
import { ObjectIcon } from "../components/ObjectIcon"
import { ObjectFilterPopover } from "../components/objects/ObjectFilterPopover"
import { ObjectQueryBar, ObjectsQueryPagination } from "../components/objects/ObjectQueryBar"
import { useObjectLiveUpdates } from "../features/objects/hooks/useObjectLiveUpdates"
import { useProjectTelemetryUpdates } from "../features/objects/hooks/useObjectTelemetryUpdates"
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
  objectTypeCounts: ReadonlyMap<string, number>
  overviewSections: ObjectTypePreviewSection[]
  overviewLoading: boolean
  objectTypesLoading?: boolean
  sortBy: ObjectSortPreference
  classFilter?: string | null
  selectedObjectType?: AtlasObjectType | null
  selectedObjectId?: string | null
  onSortByChange: (sortBy: ObjectSortPreference) => void
  onClassFilterChange: (objectTypeId: string | null) => void
  onSelectObject: (id: string) => void
}

type ViewStyle = "cards" | "table"
const objectViewOptions = [
  { value: "cards", label: "Cards" },
  { value: "table", label: "Table" },
] as const
const emptyTelemetryUpdates = new Map<string, TelemetryUpdate[]>()

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
  objectTypeCounts,
  overviewSections,
  overviewLoading,
  objectTypesLoading = false,
  sortBy,
  classFilter,
  selectedObjectType,
  selectedObjectId,
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
  useObjectLiveUpdates({ enabled: Boolean(projectName) })

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
  const latestProjectUpdates = useProjectTelemetryUpdates(projectName, {
    enabled: queryMode && viewStyle === "table",
  })

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

  const recentObjects = useMemo(() => {
    const unique = new Map<string, ObjectSummary>()
    for (const section of overviewSections) {
      for (const object of section.objects) unique.set(object.id, object)
    }
    return Array.from(unique.values())
      .sort((left, right) => +new Date(right.updatedAt) - +new Date(left.updatedAt))
      .slice(0, 8)
  }, [overviewSections])

  const handleSelectObject = (objectId: string) => {
    trackRecentObject(projectName, objectId)
    onSelectObject(objectId)
  }

  const searching = queryMode
    ? searchQuery.trim().length > 0 || queryFilters.length > 0
    : searchQuery.trim().length > 0
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
  const queryObjectTypeLabel = humanizeIdentifier(
    selectedObjectType?.name || classFilter || "objects"
  )

  return (
    <div className="mx-auto w-full max-w-6xl">
      <CollectionPageTitle
        title="Objects"
        count={availableClasses.length}
        singularLabel="object type"
      />

      <div className="sticky top-0 z-30 mt-3 bg-background/92 py-2 backdrop-blur-xl supports-[backdrop-filter]:bg-background/82">
        <div className="flex flex-col gap-1.5 md:flex-row md:items-center">
          <CollectionSearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={
              queryMode
                ? textSearchEnabled
                  ? `Search ${queryObjectTypeLabel}…`
                  : "Text search unavailable"
                : "Search objects…"
            }
            disabled={queryMode && !textSearchEnabled}
          />

          <div className="flex w-full items-center gap-1.5 md:w-auto">
            <Select
              value={classFilter ?? "all"}
              onValueChange={(value) => onClassFilterChange(value === "all" ? null : value)}
            >
              <SelectTrigger className="h-9 w-full bg-white md:w-48" aria-label="Object type">
                <SelectValue placeholder="All object types" />
              </SelectTrigger>
              <SelectContent align="start">
                <SelectItem value="all">All objects</SelectItem>
                {availableClasses.map((cls) => (
                  <SelectItem key={cls} value={cls}>
                    {humanizeIdentifier(cls)} · {formatCount(objectTypeCounts.get(cls) ?? 0)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {classFilter ? (
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                onClick={() => onClassFilterChange(null)}
                className="size-9 shrink-0 bg-white"
                aria-label="Show all objects"
                title="Show all objects"
              >
                <X className="size-4" />
              </Button>
            ) : null}
          </div>

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
                <SelectTrigger
                  size="sm"
                  className="h-9 w-36 bg-white text-xs"
                  aria-label="Sort objects"
                >
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
                <SelectTrigger
                  size="sm"
                  className="h-9 w-32 bg-white text-xs"
                  aria-label="Sort objects"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="primaryId">Primary ID</SelectItem>
                  <SelectItem value="updatedAt">Updated at</SelectItem>
                </SelectContent>
              </Select>
            )}
            {queryMode ? (
              <div className="[&_[data-slot=toggle-group]]:h-9">
                <CollectionViewToggle
                  value={viewStyle}
                  options={objectViewOptions}
                  onChange={(style) => {
                    setViewStyle(style)
                    setObjectViewStyle(style)
                  }}
                />
              </div>
            ) : null}
            {queryMode && selectedObjectType ? (
              <ObjectFilterPopover
                properties={filterableProperties}
                filters={queryFilters}
                facetResults={facetsQuery.data ?? []}
                onAddFilter={(filter) => setQueryFilters((current) => [...current, filter])}
              />
            ) : null}
            {queryMode && searching ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-9 px-2.5"
                onClick={() => {
                  setSearchQuery("")
                  setQueryFilters([])
                }}
              >
                <X />
                Clear
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {queryMode && selectedObjectType ? (
        <ObjectQueryBar
          filters={queryFilters}
          matchMode={queryMatchMode}
          propertiesById={queryPropertiesById}
          facetResults={facetsQuery.data ?? []}
          facetsLoading={facetsQuery.isLoading}
          queryError={queryError}
          onAddFilter={(filter) => setQueryFilters((current) => [...current, filter])}
          onRemoveFilter={(filterId) =>
            setQueryFilters((current) => current.filter((filter) => filter.id !== filterId))
          }
          onMatchModeChange={setQueryMatchMode}
        />
      ) : null}

      <div className="mt-6 space-y-6">
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
        ) : !selectedTypeMode && searching ? (
          <section className="space-y-3">
            <SectionHeading
              title="Matching previews"
              description={`${formatCount(filteredObjects.length)} loaded objects match this search.`}
            />
            <TableView
              objects={filteredObjects}
              updatesByObject={emptyTelemetryUpdates}
              selectedObjectId={selectedObjectId ?? null}
              onSelectObject={handleSelectObject}
            />
          </section>
        ) : !selectedTypeMode ? (
          <ObjectsOverview
            sections={filteredOverviewSections}
            recentObjects={recentObjects}
            onSelectType={onClassFilterChange}
            onSelectObject={handleSelectObject}
          />
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

function SectionHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
      <h2 className="text-base font-semibold tracking-[-0.02em] text-foreground">{title}</h2>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
  )
}

function ObjectsOverview({
  sections,
  recentObjects,
  onSelectType,
  onSelectObject,
}: {
  sections: ObjectTypePreviewSection[]
  recentObjects: ObjectSummary[]
  onSelectType: (objectTypeId: string) => void
  onSelectObject: (objectId: string) => void
}) {
  return (
    <div className="space-y-8">
      {recentObjects.length > 0 ? (
        <section className="space-y-3">
          <SectionHeading title="Recently updated" />
          <div className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 xl:grid-cols-4">
            {recentObjects.map((object) => {
              const label = object.name || humanizeIdentifier(object.id)
              return (
                <button
                  key={object.id}
                  type="button"
                  onClick={() => onSelectObject(object.id)}
                  className="group flex min-h-24 min-w-0 flex-col items-start bg-card p-4 text-left transition-colors hover:bg-[var(--atlas-surface-hover)] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex w-full min-w-0 items-center gap-2">
                    <ObjectIcon
                      type={object.class}
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="truncate text-sm font-medium text-foreground">{label}</span>
                    <ArrowRight className="ml-auto size-3.5 shrink-0 text-muted-foreground opacity-0 transition-[opacity,transform] group-hover:translate-x-0.5 group-hover:opacity-100" />
                  </div>
                  <p className="mt-auto pt-3 text-[11px] text-muted-foreground">
                    {humanizeIdentifier(object.class)} · {formatRelativeTime(object.updatedAt)}
                  </p>
                </button>
              )
            })}
          </div>
        </section>
      ) : null}

      <section className="space-y-3">
        <SectionHeading
          title="Browse by type"
          description={`${formatCount(sections.length)} populated object types.`}
        />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {sections.map((section) => (
            <ObjectTypeSummaryCard
              key={section.objectTypeId}
              section={section}
              onClick={() => onSelectType(section.objectTypeId)}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

function ObjectTypeSummaryCard({
  section,
  onClick,
}: {
  section: ObjectTypePreviewSection
  onClick: () => void
}) {
  const label = humanizeIdentifier(section.objectTypeId)
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-40 flex-col rounded-xl border border-border bg-card p-4 text-left transition-[border-color,background-color,transform] hover:-translate-y-0.5 hover:border-[var(--atlas-border-hover)] hover:bg-[var(--atlas-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex w-full items-start gap-3">
        <LetterAvatar label={label} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-foreground">{label}</h3>
          <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
            {formatCount(section.total)} object{section.total === 1 ? "" : "s"}
          </p>
        </div>
        <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </div>
      <div className="mt-4 w-full space-y-1.5 border-t border-border/70 pt-3">
        {section.objects.slice(0, 3).map((object) => (
          <p key={object.id} className="truncate text-xs text-muted-foreground">
            {object.name || humanizeIdentifier(object.id)}
          </p>
        ))}
      </div>
    </button>
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
