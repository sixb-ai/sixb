import type { PennylaneHttp } from "../http"
import { listAllCursor } from "../pagination"
import type {
  PennylaneChange,
  PennylaneChangeListOptions,
  PennylaneCursorPage,
  QueryParams,
} from "../types"
import { assertCursorOptions } from "../validation"

export interface ChangesResource {
  /** `GET /changelogs/{resource}` */
  list(options?: PennylaneChangeListOptions): Promise<PennylaneCursorPage<PennylaneChange>>
  listAll(options?: PennylaneChangeListOptions): AsyncIterable<PennylaneChange>
}

/**
 * Builds a resource over a Pennylane change log (`/changelogs/{path}`). Every change log shares the
 * same shape, so quotes, products, and customers reuse this one factory. `label` only appears in
 * validation error messages (e.g. "product changes").
 */
export function createChangesResource(
  http: PennylaneHttp,
  path: string,
  label: string
): ChangesResource {
  const resource: ChangesResource = {
    list(options) {
      assertChangeOptions(options, label)
      return http.get(path, changeListQuery(options))
    },
    listAll(options) {
      return listAllCursor((pageOptions) => resource.list(nextChangeOptions(pageOptions)), options)
    },
  }

  return resource
}

function nextChangeOptions(
  options: PennylaneChangeListOptions | undefined
): PennylaneChangeListOptions | undefined {
  // Pennylane rejects cursor and start_date together. start_date seeds only the first page.
  if (options?.cursor) {
    return { cursor: options.cursor, limit: options.limit }
  }

  return options
}

function assertChangeOptions(options: PennylaneChangeListOptions | undefined, label: string): void {
  assertCursorOptions(options, 1000)

  const unsafeOptions = options as
    | { readonly cursor?: string; readonly start_date?: string }
    | undefined
  if (unsafeOptions?.cursor !== undefined && unsafeOptions.start_date !== undefined) {
    throw new Error(`[SixbPennylane] ${label} cursor and start_date are mutually exclusive.`)
  }
  if (unsafeOptions?.start_date !== undefined && !unsafeOptions.start_date.trim()) {
    throw new Error(`[SixbPennylane] ${label} start_date must not be empty when provided.`)
  }
}

function changeListQuery(options: PennylaneChangeListOptions | undefined): QueryParams {
  return {
    cursor: options?.cursor,
    limit: options?.limit,
    start_date: options?.start_date,
  }
}
