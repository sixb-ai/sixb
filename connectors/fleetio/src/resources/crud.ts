import type { FleetioHttp } from "../http"
import { listAllPages } from "../pagination"
import { listQuery, searchBody } from "../query"
import type { FleetioId, FleetioListOptions, FleetioPage } from "../types"
import { pathId } from "../validation"

export interface FleetioListMethods<TItem, TFilter = never, TSort = never> {
  /** One page of records. */
  list(options?: FleetioListOptions<TFilter, TSort>): Promise<FleetioPage<TItem>>
  /** Every record across all pages. */
  listAll(options?: FleetioListOptions<TFilter, TSort>): AsyncIterable<TItem>
}

export interface FleetioGetMethod<TRecord> {
  get(id: FleetioId): Promise<TRecord>
}

export interface FleetioCreateMethod<TInput, TCreated> {
  create(input: TInput): Promise<TCreated>
}

/** `TUpdated` is `void` on the routes where Fleetio answers an update with no body. */
export interface FleetioUpdateMethod<TInput, TUpdated = void> {
  update(id: FleetioId, input: TInput): Promise<TUpdated>
}

export interface FleetioDeleteMethod {
  delete(id: FleetioId): Promise<void>
}

export type FleetioReadMethods<TItem, TRecord, TFilter = never, TSort = never> = FleetioListMethods<
  TItem,
  TFilter,
  TSort
> &
  FleetioGetMethod<TRecord>

export type FleetioWriteMethods<TCreate, TCreated, TUpdate, TUpdated = void> = FleetioCreateMethod<
  TCreate,
  TCreated
> &
  FleetioUpdateMethod<TUpdate, TUpdated> &
  FleetioDeleteMethod

export function listMethods<TItem, TFilter = never, TSort = never>(
  http: FleetioHttp,
  path: string
): FleetioListMethods<TItem, TFilter, TSort> {
  const methods: FleetioListMethods<TItem, TFilter, TSort> = {
    list(options) {
      return http.get(path, listQuery(options))
    },
    listAll(options) {
      return listAllPages(methods.list, options)
    },
  }

  return methods
}

export function readMethods<TItem, TRecord, TFilter = never, TSort = never>(
  http: FleetioHttp,
  path: string,
  idField: string
): FleetioReadMethods<TItem, TRecord, TFilter, TSort> {
  return {
    ...listMethods<TItem, TFilter, TSort>(http, path),
    get(id) {
      return http.get(`${path}/${pathId(id, idField)}`)
    },
  }
}

export function writeMethods<TCreate, TCreated, TUpdate, TUpdated = void>(
  http: FleetioHttp,
  path: string,
  idField: string
): FleetioWriteMethods<TCreate, TCreated, TUpdate, TUpdated> {
  return {
    create(input) {
      return http.post(path, input)
    },
    update(id, input) {
      return http.patch(`${path}/${pathId(id, idField)}`, input)
    },
    delete(id) {
      return http.delete(`${path}/${pathId(id, idField)}`)
    },
  }
}

/** The read and write methods of a record that lives under a parent, with the parent's ID first. */
export interface FleetioNestedMethods<
  TItem,
  TRecord,
  TCreate,
  TCreated,
  TUpdate,
  TUpdated = void,
  TSort = never,
> {
  list(parentId: FleetioId, options?: FleetioListOptions<never, TSort>): Promise<FleetioPage<TItem>>
  listAll(parentId: FleetioId, options?: FleetioListOptions<never, TSort>): AsyncIterable<TItem>
  get(parentId: FleetioId, id: FleetioId): Promise<TRecord>
  create(parentId: FleetioId, input: TCreate): Promise<TCreated>
  update(parentId: FleetioId, id: FleetioId, input: TUpdate): Promise<TUpdated>
  delete(parentId: FleetioId, id: FleetioId): Promise<void>
}

export function nestedMethods<
  TItem,
  TRecord,
  TCreate,
  TCreated,
  TUpdate,
  TUpdated = void,
  TSort = never,
>(
  http: FleetioHttp,
  parentPath: string,
  parentField: string,
  childPath: string,
  idField: string
): FleetioNestedMethods<TItem, TRecord, TCreate, TCreated, TUpdate, TUpdated, TSort> {
  const path = (parentId: FleetioId) =>
    `${parentPath}/${pathId(parentId, parentField)}/${childPath}`

  return {
    list(parentId, options) {
      return http.get(path(parentId), listQuery(options))
    },
    listAll(parentId, options) {
      return listMethods<TItem, never, TSort>(http, path(parentId)).listAll(options)
    },
    get(parentId, id) {
      return http.get(`${path(parentId)}/${pathId(id, idField)}`)
    },
    create(parentId, input) {
      return http.post(path(parentId), input)
    },
    update(parentId, id, input) {
      return http.patch(`${path(parentId)}/${pathId(id, idField)}`, input)
    },
    delete(parentId, id) {
      return http.delete(`${path(parentId)}/${pathId(id, idField)}`)
    },
  }
}

/** Fleetio's `POST .../search`: the same page of records, with the options in a JSON body. */
export interface FleetioSearchMethods<TItem, TFilter, TSort> {
  search(options?: FleetioListOptions<TFilter, TSort>): Promise<FleetioPage<TItem>>
  searchAll(options?: FleetioListOptions<TFilter, TSort>): AsyncIterable<TItem>
}

export function searchMethods<TItem, TFilter, TSort>(
  http: FleetioHttp,
  path: string
): FleetioSearchMethods<TItem, TFilter, TSort> {
  const methods: FleetioSearchMethods<TItem, TFilter, TSort> = {
    search(options) {
      return http.post(path, searchBody(options), { idempotent: true })
    },
    searchAll(options) {
      return listAllPages(methods.search, options)
    },
  }

  return methods
}
