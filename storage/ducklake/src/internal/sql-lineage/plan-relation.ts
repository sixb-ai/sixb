import { rejectPlanFormat } from "./rejection"

/** Source columns, as ids assigned by the analysis session, that something depends on. */
export type Dependencies = ReadonlySet<number>

/**
 * A planner-internal column past the end of a table's columns: `rowid`, or the placeholder a
 * `count(*)` scan reads. Scanning one is allowed; depending on one rejects the transform.
 */
export const VIRTUAL_COLUMN = -1

/** A column flowing out of a plan operator. */
export interface PlanColumn {
  readonly dependencies: Dependencies
  /**
   * `table_index.column_index` in the plan. Most expressions reference their input by position
   * (BOUND_REF); the subtree under a table function's input keeps binding references instead.
   */
  readonly binding?: string
}

/** The output of a plan operator: its columns, and what decides which rows exist and their order. */
export interface PlanRelation {
  readonly columns: readonly PlanColumn[]
  readonly rows: Dependencies
}

export function bindingKey(tableIndex: number, columnIndex: number): string {
  return `${tableIndex}.${columnIndex}`
}

/** Positional access into an operator's columns or index lists. */
export function itemAt<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index]
  if (item === undefined) {
    rejectPlanFormat(`${what} ${index} is out of range`)
  }

  return item
}

export function unionOf(...sets: readonly Dependencies[]): Set<number> {
  const union = new Set<number>()
  for (const set of sets) {
    addAll(union, set)
  }

  return union
}

export function addAll(target: Set<number>, source: Iterable<number>): void {
  for (const item of source) {
    target.add(item)
  }
}

export function sameDependencies(left: Dependencies, right: Dependencies): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item))
}
