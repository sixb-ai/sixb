export type RunListOrder = "asc" | "desc"

export type { ListPage as RunListPage, ListWindow as RunListWindow } from "./pagination"
export { paginate } from "./pagination"

export interface StartedAtRunRecord<TStatus extends string = string> {
  readonly id: string
  readonly status: TStatus
  readonly startedAt: Date
}

export interface RunListDateFilters<TStatus extends string = string> {
  readonly statuses?: readonly TStatus[]
  readonly startedAfter?: Date
  readonly startedBefore?: Date
}

export function storageKey(projectId: string, id: string): string {
  return `${projectId}:${id}`
}

export function cloneRecord<T>(record: T): T {
  return structuredClone(record)
}

export function hasEmptyStatuses(input: { readonly statuses?: readonly unknown[] }): boolean {
  return input.statuses !== undefined && input.statuses.length === 0
}

export function toStatusSet<TStatus extends string>(
  statuses: readonly TStatus[] | undefined
): ReadonlySet<TStatus> | null {
  return statuses ? new Set(statuses) : null
}

export function matchesRunListDateFilters<TStatus extends string>(
  record: StartedAtRunRecord<TStatus>,
  filters: {
    readonly statuses: ReadonlySet<TStatus> | null
    readonly startedAfter?: Date
    readonly startedBefore?: Date
  }
): boolean {
  if (filters.statuses && !filters.statuses.has(record.status)) {
    return false
  }

  if (filters.startedAfter && record.startedAt < filters.startedAfter) {
    return false
  }

  if (filters.startedBefore && record.startedAt > filters.startedBefore) {
    return false
  }

  return true
}

export function compareStartedAt(
  left: { readonly id: string; readonly startedAt: Date },
  right: { readonly id: string; readonly startedAt: Date },
  order: RunListOrder
): number {
  const delta = left.startedAt.getTime() - right.startedAt.getTime()
  if (delta !== 0) {
    return order === "asc" ? delta : -delta
  }

  if (left.id === right.id) {
    return 0
  }

  return order === "asc" ? left.id.localeCompare(right.id) : right.id.localeCompare(left.id)
}
