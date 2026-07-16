import type { PennylaneHttp } from "../http"
import { listAllCursor } from "../pagination"
import type {
  PennylaneCursorPage,
  PennylaneQuoteChange,
  PennylaneQuoteChangeListOptions,
  QueryParams,
} from "../types"
import { assertCursorOptions } from "../validation"

export interface QuoteChangesResource {
  /** `GET /changelogs/quotes` */
  list(
    options?: PennylaneQuoteChangeListOptions
  ): Promise<PennylaneCursorPage<PennylaneQuoteChange>>
  listAll(options?: PennylaneQuoteChangeListOptions): AsyncIterable<PennylaneQuoteChange>
}

export function createQuoteChangesResource(http: PennylaneHttp): QuoteChangesResource {
  const resource: QuoteChangesResource = {
    list(options) {
      assertChangeOptions(options)
      return http.get("changelogs/quotes", changeListQuery(options))
    },
    listAll(options) {
      return listAllCursor((pageOptions) => resource.list(nextChangeOptions(pageOptions)), options)
    },
  }

  return resource
}

function nextChangeOptions(
  options: PennylaneQuoteChangeListOptions | undefined
): PennylaneQuoteChangeListOptions | undefined {
  // Pennylane rejects cursor and start_date together. start_date seeds only the first page.
  if (options?.cursor) {
    return { cursor: options.cursor, limit: options.limit }
  }

  return options
}

function assertChangeOptions(options: PennylaneQuoteChangeListOptions | undefined): void {
  assertCursorOptions(options, 1000)

  const unsafeOptions = options as
    | { readonly cursor?: string; readonly start_date?: string }
    | undefined
  if (unsafeOptions?.cursor !== undefined && unsafeOptions.start_date !== undefined) {
    throw new Error("[SixbPennylane] quote changes cursor and start_date are mutually exclusive.")
  }
  if (unsafeOptions?.start_date !== undefined && !unsafeOptions.start_date.trim()) {
    throw new Error("[SixbPennylane] quote changes start_date must not be empty when provided.")
  }
}

function changeListQuery(options: PennylaneQuoteChangeListOptions | undefined): QueryParams {
  return {
    cursor: options?.cursor,
    limit: options?.limit,
    start_date: options?.start_date,
  }
}
