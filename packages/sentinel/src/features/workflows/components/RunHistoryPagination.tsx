import { Button } from "@pario/ui/components"
import { ChevronLeft, ChevronRight } from "lucide-react"

export function RunHistoryPagination({
  page,
  pageSize,
  visibleCount,
  total,
  hasMore,
  onPageChange,
}: {
  page: number
  pageSize: number
  visibleCount: number
  total: number
  hasMore: boolean
  onPageChange: (page: number) => void
}) {
  const start = total === 0 ? 0 : page * pageSize + 1
  const end = Math.min(page * pageSize + visibleCount, total)

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted-foreground">
        Showing <span className="font-medium text-foreground">{start}</span> to{" "}
        <span className="font-medium text-foreground">{end}</span> of{" "}
        <span className="font-medium text-foreground">{total}</span>
      </p>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page - 1)}
          disabled={page === 0}
        >
          <ChevronLeft />
          Previous
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page + 1)}
          disabled={!hasMore}
        >
          Next
          <ChevronRight />
        </Button>
      </div>
    </div>
  )
}
