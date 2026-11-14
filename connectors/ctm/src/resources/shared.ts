import type { RestQueryParams } from "@sixb/connector-rest"
import type { CtmHttp } from "../http"
import { toPage, WALK_PAGE_SIZE, walkPages } from "../pagination"
import type { CtmId, CtmPage, CtmPageOptions } from "../types"
import { assertPositiveInteger, pathId } from "../validation"

/** Resolves a path under the client's account: `calls` becomes `accounts/123/calls`. */
export type CtmAccountPath = (suffix: string) => string

export interface CtmListMethods<TRecord, TOptions extends CtmPageOptions = CtmPageOptions> {
  /** One page of records. */
  list(options?: TOptions): Promise<CtmPage<TRecord>>
  /** Every record, from `options.page` (or the first page) to the last, 100 a page by default. */
  listAll(options?: TOptions): AsyncIterable<TRecord>
}

export interface CtmGetMethod<TRecord> {
  get(id: CtmId): Promise<TRecord>
}

export type CtmReadMethods<
  TRecord,
  TOptions extends CtmPageOptions = CtmPageOptions,
> = CtmListMethods<TRecord, TOptions> & CtmGetMethod<TRecord>

/**
 * A page-numbered list. `key` names the records array in CTM's envelope, and `query` turns the
 * resource's own options into CTM's parameters.
 */
export function listMethods<TRecord, TOptions extends CtmPageOptions = CtmPageOptions>(
  http: CtmHttp,
  path: () => string,
  key: string,
  query: (options: TOptions | undefined) => RestQueryParams = () => ({})
): CtmListMethods<TRecord, TOptions> {
  const methods: CtmListMethods<TRecord, TOptions> = {
    async list(options) {
      assertPositiveInteger(options?.page, "page")
      assertPositiveInteger(options?.pageSize, "pageSize")

      const page = options?.page ?? 1
      const body = await http.get(path(), {
        ...query(options),
        page,
        per_page: options?.pageSize,
      })

      return toPage<TRecord>(body, key, page)
    },

    listAll(options) {
      const pageSize = options?.pageSize ?? WALK_PAGE_SIZE

      return walkPages(
        (page) => methods.list({ ...options, pageSize, page } as TOptions),
        options?.page
      )
    },
  }

  return methods
}

/** A list with a detail route at `<path>/<id>`. */
export function readMethods<TRecord, TOptions extends CtmPageOptions = CtmPageOptions>(
  http: CtmHttp,
  at: CtmAccountPath,
  resource: string,
  key: string,
  idField: string,
  query?: (options: TOptions | undefined) => RestQueryParams
): CtmReadMethods<TRecord, TOptions> {
  return {
    ...listMethods<TRecord, TOptions>(http, () => at(resource), key, query),

    async get(id) {
      return http.get<TRecord>(at(`${resource}/${pathId(id, idField)}`))
    },
  }
}
