import { MicrosoftConfigurationError } from "../../errors"
import type { MicrosoftHttp } from "../../http"
import { allPages, page } from "../../pagination"
import type { RequestOptions, SelectOptions } from "../../types/common"
import type {
  DirectoryObject,
  DirectoryPage,
  DirectoryQueryOptions,
  OrgContact,
} from "../../types/directory"
import { nonEmpty, query, resource, segment } from "../../validation"
import { type OrgContactDeltaResource, orgContactDeltaResource } from "./delta"

/** Graph documents only `$select` for these relationships. */
export type DirectorySelectOptions = RequestOptions & { readonly select?: readonly string[] }
/** Graph accepts these options on group memberships only as advanced queries. */
export type DirectoryMembershipOptions = Omit<
  DirectoryQueryOptions,
  "orderBy" | "expand" | "advancedQuery"
>

export interface OrgContactsResource {
  readonly delta: OrgContactDeltaResource
  list(options?: DirectoryQueryOptions): Promise<DirectoryPage<OrgContact>>
  listAll(options?: DirectoryQueryOptions): AsyncIterable<OrgContact>
  get(id: string, options?: SelectOptions): Promise<OrgContact>
  /** Graph answers 404 when the contact has no manager. */
  getManager(id: string, options?: DirectorySelectOptions): Promise<DirectoryObject>
  listDirectReports(
    id: string,
    options?: DirectorySelectOptions
  ): Promise<DirectoryPage<DirectoryObject>>
  listAllDirectReports(id: string, options?: DirectorySelectOptions): AsyncIterable<DirectoryObject>
  /** Groups and administrative units the contact belongs to directly. */
  listMemberOf(
    id: string,
    options?: DirectoryMembershipOptions
  ): Promise<DirectoryPage<DirectoryObject>>
  listAllMemberOf(id: string, options?: DirectoryMembershipOptions): AsyncIterable<DirectoryObject>
  /** Includes groups the contact belongs to through nested groups. Also needs Group.Read.All. */
  listTransitiveMemberOf(
    id: string,
    options?: DirectoryMembershipOptions
  ): Promise<DirectoryPage<DirectoryObject>>
  listAllTransitiveMemberOf(
    id: string,
    options?: DirectoryMembershipOptions
  ): AsyncIterable<DirectoryObject>
}

/** Query string and headers, including Graph's advanced-query mode when it is required. */
export function directoryRequest(
  options: DirectoryQueryOptions | undefined,
  advanced = options?.advancedQuery === true
): { readonly path: string; readonly headers?: HeadersInit } {
  const eventual = advanced || options?.search !== undefined
  if (eventual && options?.expand !== undefined)
    throw new MicrosoftConfigurationError("Graph does not support expand in advanced queries.")
  const params = new URLSearchParams(query(options).slice(1))
  if (options?.filter !== undefined) params.set("$filter", nonEmpty(options.filter, "filter"))
  if (options?.search !== undefined) params.set("$search", nonEmpty(options.search, "search"))
  if (advanced) params.set("$count", "true")
  return {
    path: params.size ? `?${params}` : "",
    ...(eventual ? { headers: { ConsistencyLevel: "eventual" } } : {}),
  }
}
function selectOnly(options?: DirectorySelectOptions): string {
  for (const key of ["expand", "top", "orderBy", "filter", "search"])
    if (options && key in options)
      throw new MicrosoftConfigurationError(`This directory relationship does not support ${key}.`)
  return query(options)
}
const contactPath = (id: string) => `contacts/${segment(id, "orgContactId")}`

export function orgContactsResource(http: MicrosoftHttp): OrgContactsResource {
  const list = async <T extends { id: string }>(
    path: string,
    options?: DirectoryQueryOptions,
    advanced?: boolean
  ): Promise<DirectoryPage<T>> => {
    const request = directoryRequest(options, advanced)
    return page<T>(
      await http.json(`${path}${request.path}`, {
        headers: request.headers,
        signal: options?.signal,
      })
    )
  }
  const listAll = <T extends { id: string }>(
    path: string,
    options?: DirectoryQueryOptions,
    advanced?: boolean
  ): AsyncIterable<T> => {
    const request = directoryRequest(options, advanced)
    return allPages(http, `${path}${request.path}`, options, request.headers)
  }
  // Membership queries take options only in advanced mode; a plain listing needs no header.
  const membership = (options?: DirectoryMembershipOptions) =>
    [options?.filter, options?.search, options?.select, options?.top].some(
      (value) => value !== undefined
    )
  return {
    delta: orgContactDeltaResource(http),
    list: async (options) => list("contacts", options),
    listAll: (options) => listAll("contacts", options),
    async get(id, options) {
      return resource(
        await http.json(`${contactPath(id)}${query(options)}`, { signal: options?.signal })
      )
    },
    async getManager(id, options) {
      return resource(
        await http.json(`${contactPath(id)}/manager${selectOnly(options)}`, {
          signal: options?.signal,
        })
      )
    },
    async listDirectReports(id, options) {
      return page(
        await http.json(`${contactPath(id)}/directReports${selectOnly(options)}`, {
          signal: options?.signal,
        })
      )
    },
    listAllDirectReports: (id, options) =>
      allPages(http, `${contactPath(id)}/directReports${selectOnly(options)}`, options),
    listMemberOf: async (id, options) =>
      list(`${contactPath(id)}/memberOf`, options, membership(options)),
    listAllMemberOf: (id, options) =>
      listAll(`${contactPath(id)}/memberOf`, options, membership(options)),
    listTransitiveMemberOf: async (id, options) =>
      list(`${contactPath(id)}/transitiveMemberOf`, options, membership(options)),
    listAllTransitiveMemberOf: (id, options) =>
      listAll(`${contactPath(id)}/transitiveMemberOf`, options, membership(options)),
  }
}
