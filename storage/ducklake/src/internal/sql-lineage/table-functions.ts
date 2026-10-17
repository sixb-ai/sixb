/**
 * Table functions that compute only from their arguments. Every other table function reads outside
 * the transform's sources (files, catalogs, settings) or runs SQL of its own, like `query()`.
 */
export const PURE_TABLE_FUNCTIONS: ReadonlySet<string> = new Set([
  "range",
  "generate_series",
  "unnest",
  "json_each",
  "json_tree",
])
