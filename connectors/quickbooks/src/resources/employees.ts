import { listAll, listEntities, pathId, readEntity } from "../query"
import type { QuickBooksEmployee } from "../types/entities"
import type { QuickBooksEmployeeListOptions, QuickBooksPage } from "../types/query"
import type {
  QuickBooksEmployeeCreate,
  QuickBooksEmployeeUpdate,
  QuickBooksRevision,
  QuickBooksWriteOptions,
} from "../types/writes"
import { nonEmpty } from "../validation"
import {
  createInput,
  type QuickBooksWriteHttp,
  revision,
  updateEntity,
  writeEntity,
} from "../write"

/** Employees are deactivated, not deleted. */
export interface QuickBooksEmployeesResource {
  create(
    input: QuickBooksEmployeeCreate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksEmployee>
  /** Sparse update using the caller's current SyncToken. */
  update(
    input: QuickBooksEmployeeUpdate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksEmployee>
  deactivate(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksEmployee>
  reactivate(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksEmployee>
  /** GET /v3/company/{realmId}/employee/{id} */
  get(id: string): Promise<QuickBooksEmployee>
  list(options?: QuickBooksEmployeeListOptions): Promise<QuickBooksPage<QuickBooksEmployee>>
  listAll(options?: QuickBooksEmployeeListOptions): AsyncIterable<QuickBooksEmployee>
}

export function createEmployeesResource(http: QuickBooksWriteHttp): QuickBooksEmployeesResource {
  const resource: QuickBooksEmployeesResource = {
    async create(input, options) {
      createInput(input)
      if (
        input.DisplayName === undefined &&
        input.GivenName === undefined &&
        input.FamilyName === undefined
      )
        throw new Error(
          "[SixbQuickBooks] Employee creation requires DisplayName, GivenName, or FamilyName."
        )
      names(input)
      return writeEntity(http, "Employee", "employee", input, options)
    },
    async update(input, options) {
      names(input)
      return updateEntity(http, "Employee", input, options)
    },
    deactivate: async (input, options) =>
      resource.update({ ...revision(input), Active: false }, options),
    reactivate: async (input, options) =>
      resource.update({ ...revision(input), Active: true }, options),
    get: (id) => readEntity(http, "Employee", `employee/${pathId(id)}`, id),
    list: (options) => listEntities(http, "Employee", "DisplayName", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}

function names(input: { DisplayName?: string; GivenName?: string; FamilyName?: string }) {
  for (const field of ["DisplayName", "GivenName", "FamilyName"] as const)
    if (input[field] !== undefined) nonEmpty(input[field], field)
}
