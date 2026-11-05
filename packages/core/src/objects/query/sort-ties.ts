import type { ObjectQuerySortDirection, ObjectQuerySortField } from "./ir"

/**
 * The direction objects equal on every sorted property come in: their identity order, reversed
 * when the last property sorted descends.
 *
 * A descending sort then lists the ascending one backwards, apart from null values, which sort last
 * either way. That is what lets PostgreSQL serve both from one ascending index, read backwards for
 * the descending one. Every provider and the fallback reverse their tie order this way.
 */
export function sortTieDirection(
  fields: readonly ObjectQuerySortField[]
): ObjectQuerySortDirection {
  const last = fields.filter((field) => field.kind === "property").at(-1)
  return last?.direction === "desc" ? "desc" : "asc"
}
