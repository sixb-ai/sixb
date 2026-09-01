import type { ObjectQueryFacetResult } from "@sixb/client"
import { Alert, AlertDescription, Badge, Button } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { AlertCircle, X } from "lucide-react"
import { formatCount, formatValue } from "../../lib/formatValue"
import {
  createFilterId,
  describeFilter,
  filterHasValue,
  getObjectQueryError,
  getPropertyLabel,
  type QueryFilter,
  type QueryMatchMode,
  type QueryProperty,
} from "../../lib/objects/objectQuery"

export function ObjectQueryBar({
  filters,
  matchMode,
  propertiesById,
  facetResults,
  facetsLoading,
  queryError,
  onAddFilter,
  onRemoveFilter,
  onMatchModeChange,
}: {
  filters: QueryFilter[]
  matchMode: QueryMatchMode
  propertiesById: ReadonlyMap<string, QueryProperty>
  facetResults: ObjectQueryFacetResult[]
  facetsLoading: boolean
  queryError: unknown
  onAddFilter: (filter: QueryFilter) => void
  onRemoveFilter: (filterId: string) => void
  onMatchModeChange: (mode: QueryMatchMode) => void
}) {
  return (
    <div className="mt-3 space-y-3">
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
