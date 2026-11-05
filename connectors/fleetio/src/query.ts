import type { RestQueryParams } from "@sixb/connector-rest"
import type { FleetioListOptions } from "./types"
import { assertPageSize } from "./validation"

/**
 * Query parameters for a paginated list. Fleetio reads filters and sorts as nested parameters such
 * as `filter[updated_at][gte]=...` and `sort[updated_at]=asc`, which the shared flat query helper
 * cannot express, so they are flattened here.
 */
export function listQuery(options?: FleetioListOptions<unknown, unknown>): RestQueryParams {
  assertPageSize(options?.pageSize)

  return {
    start_cursor: options?.cursor,
    per_page: options?.pageSize,
    ...flatten("filter", options?.filter),
    ...flatten("sort", options?.sort),
  }
}

/** The same list options as a JSON body, for Fleetio's `POST .../search` routes. */
export function searchBody(options?: FleetioListOptions<unknown, unknown>): unknown {
  assertPageSize(options?.pageSize)

  return {
    start_cursor: options?.cursor,
    per_page: options?.pageSize,
    filter: options?.filter,
    sort: options?.sort,
  }
}

function flatten(key: string, value: unknown): Record<string, string> {
  if (value === undefined || value === null) {
    return {}
  }

  if (Array.isArray(value)) {
    // Fleetio's `include` operator takes a comma-separated list.
    return value.length > 0 ? { [key]: value.join(",") } : {}
  }

  if (typeof value === "object") {
    return Object.assign(
      {},
      ...Object.entries(value).map(([child, nested]) => flatten(`${key}[${child}]`, nested))
    )
  }

  return { [key]: String(value) }
}
