import type { ObjectQueryFacetResult } from "@sixb/client"
import { Alert, AlertDescription, Badge, Button, Input } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { AlertCircle, Search, X } from "lucide-react"
import { formatCount, formatValue } from "../../lib/formatValue"
import { humanizeIdentifier } from "../../lib/labels"
import {
  type AtlasObjectType,
  createFilterId,
  describeFilter,
  filterHasValue,
  getObjectQueryError,
  getPropertyLabel,
  type QueryFilter,
  type QueryMatchMode,
  type QueryProperty,
} from "../../lib/objects/objectQuery"
import { ObjectFilterPopover } from "./ObjectFilterPopover"

export function ObjectQueryBar({
  objectType,
  searchQuery,
  textSearchEnabled,
  filters,
  matchMode,
  filterableProperties,
  propertiesById,
  facetResults,
  facetsLoading,
  queryError,
  onSearchQueryChange,
  onAddFilter,
  onRemoveFilter,
  onClear,
  onMatchModeChange,
}: {
  objectType: AtlasObjectType
  searchQuery: string
  textSearchEnabled: boolean
  filters: QueryFilter[]
  matchMode: QueryMatchMode
  filterableProperties: QueryProperty[]
  propertiesById: ReadonlyMap<string, QueryProperty>
  facetResults: ObjectQueryFacetResult[]
  facetsLoading: boolean
  queryError: unknown
  onSearchQueryChange: (value: string) => void
  onAddFilter: (filter: QueryFilter) => void
  onRemoveFilter: (filterId: string) => void
  onClear: () => void
  onMatchModeChange: (mode: QueryMatchMode) => void
}) {
  const active = searchQuery.trim().length > 0 || filters.length > 0
  const objectTypeLabel = humanizeIdentifier(objectType.name || objectType.id)
  const addFilterLabel = textSearchEnabled || active ? "Filter" : `Filter ${objectTypeLabel}`

  return (
    <div className="mt-3 space-y-3">
      {textSearchEnabled ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              placeholder={`Search ${objectTypeLabel}...`}
              className="h-10 rounded-xl bg-card pl-9 shadow-none"
            />
          </div>
          <QueryToolbarActions
            active={active}
            filters={filters}
            facetResults={facetResults}
            filterLabel={addFilterLabel}
            filterableProperties={filterableProperties}
            onAddFilter={onAddFilter}
            onClear={onClear}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-xl bg-muted/35 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-medium text-foreground">Filter {objectTypeLabel}</p>
            <p className="text-xs text-muted-foreground">
              Text search is not configured for this type. Use fields to narrow the set.
            </p>
          </div>
          <QueryToolbarActions
            active={active}
            filters={filters}
            facetResults={facetResults}
            filterLabel={addFilterLabel}
            filterableProperties={filterableProperties}
            prominent={!active}
            onAddFilter={onAddFilter}
            onClear={onClear}
          />
        </div>
      )}

      {filters.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Where
          </span>
          {filters.length > 1 ? (
            <div className="mr-1 inline-flex h-7 rounded-full bg-muted p-0.5 text-[11px]">
              <button
                type="button"
                className={cn(
                  "rounded-full px-2 transition-colors",
                  matchMode === "all"
                    ? "bg-foreground text-background"
                    : "bg-background text-muted-foreground hover:bg-muted"
                )}
                onClick={() => onMatchModeChange("all")}
              >
                Match all
              </button>
              <button
                type="button"
                className={cn(
                  "rounded-full px-2 transition-colors",
                  matchMode === "any"
                    ? "bg-foreground text-background"
                    : "bg-background text-muted-foreground hover:bg-muted"
                )}
                onClick={() => onMatchModeChange("any")}
              >
                Match any
              </button>
            </div>
          ) : null}

          {filters.map((filter) => (
            <Badge key={filter.id} variant="secondary" className="gap-1 rounded-full px-2.5 py-1">
              <span>{describeFilter(filter, propertiesById)}</span>
              <button
                type="button"
                aria-label={`Remove ${describeFilter(filter, propertiesById)}`}
                className="rounded-full text-muted-foreground hover:text-foreground"
                onClick={() => onRemoveFilter(filter.id)}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}

      <FacetSuggestions
        filters={filters}
        propertiesById={propertiesById}
        facetResults={facetResults}
        loading={facetsLoading}
        onAddFilter={onAddFilter}
      />

      <ObjectQueryErrorAlert error={queryError} />
    </div>
  )
}

function QueryToolbarActions({
  active,
  filters,
  facetResults,
  filterLabel,
  filterableProperties,
  prominent = false,
  onAddFilter,
  onClear,
}: {
  active: boolean
  filters: QueryFilter[]
  facetResults: ObjectQueryFacetResult[]
  filterLabel: string
  filterableProperties: QueryProperty[]
  prominent?: boolean
  onAddFilter: (filter: QueryFilter) => void
  onClear: () => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <ObjectFilterPopover
        properties={filterableProperties}
        filters={filters}
        facetResults={facetResults}
        label={filterLabel}
        prominent={prominent}
        onAddFilter={onAddFilter}
      />
      {active ? (
        <Button type="button" variant="ghost" size="sm" className="h-10 px-2.5" onClick={onClear}>
          <X />
          Clear
        </Button>
      ) : null}
    </div>
  )
}

function FacetSuggestions({
  filters,
  propertiesById,
  facetResults,
  loading,
  onAddFilter,
}: {
  filters: QueryFilter[]
  propertiesById: ReadonlyMap<string, QueryProperty>
  facetResults: ObjectQueryFacetResult[]
  loading: boolean
  onAddFilter: (filter: QueryFilter) => void
}) {
  const suggestions = facetResults
    .flatMap((facet) => {
      const property = propertiesById.get(facet.propertyId)
      if (!property) return []
      return facet.buckets
        .filter((bucket) => !filterHasValue(filters, property.id, bucket.value))
        .slice(0, 4)
        .map((bucket) => ({ property, bucket }))
    })
    .slice(0, 8)

  if (loading && suggestions.length === 0) {
    return <p className="px-1 text-xs text-muted-foreground">Loading facet suggestions...</p>
  }

  if (suggestions.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      <span className="mr-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Try
      </span>
      {suggestions.map(({ property, bucket }) => {
        return (
          <button
            key={`${property.id}:${formatValue(bucket.value)}`}
            type="button"
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs shadow-xs transition-colors",
              "border-border bg-card text-foreground hover:border-muted-foreground/40 hover:bg-muted",
              "dark:bg-muted/45 dark:hover:bg-muted"
            )}
            onClick={() =>
              onAddFilter({
                id: createFilterId(),
                propertyId: property.id,
                operator: "eq",
                value: bucket.value,
              })
            }
          >
            <span>
              {getPropertyLabel(property)}: {formatValue(bucket.value)}
            </span>
            <span className="tabular-nums text-muted-foreground">{formatCount(bucket.count)}</span>
          </button>
        )
      })}
    </div>
  )
}

function ObjectQueryErrorAlert({ error }: { error: unknown }) {
  if (!error) return null
  const queryError = getObjectQueryError(error)
  const [firstIssue] = queryError.issues

  return (
    <Alert variant="destructive" className="mt-2">
      <AlertCircle />
      <AlertDescription>
        <p>{queryError.message}</p>
        {firstIssue ? (
          <p className="font-mono text-[11px]">
            {firstIssue.path}: {firstIssue.message}
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

export function ObjectsQueryPagination({
  loadedCount,
  total,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  loadedCount: number
  total: number
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
}) {
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs tabular-nums text-muted-foreground">
        Showing {formatCount(loadedCount)} of {formatCount(total)}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!hasMore || loadingMore}
        onClick={onLoadMore}
      >
        {loadingMore ? "Loading..." : hasMore ? "Load more" : "All results loaded"}
      </Button>
    </div>
  )
}
