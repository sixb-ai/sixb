import { listAll, listEntities, pathId, readEntity } from "../query"
import type { QuickBooksCustomer } from "../types/entities"
import type { QuickBooksCustomerListOptions, QuickBooksPage } from "../types/query"
import type {
  QuickBooksCustomerCreate,
  QuickBooksCustomerUpdate,
  QuickBooksRevision,
  QuickBooksWriteOptions,
} from "../types/writes"
import { nonEmpty } from "../validation"
import { createInput, type QuickBooksWriteHttp, revision, writeEntity } from "../write"

export interface QuickBooksCustomersResource {
  create(
    input: QuickBooksCustomerCreate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksCustomer>
  /** Sparse update using the caller's current SyncToken. */
  update(
    input: QuickBooksCustomerUpdate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksCustomer>
  deactivate(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksCustomer>
  reactivate(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksCustomer>
  get(id: string): Promise<QuickBooksCustomer>
  list(options?: QuickBooksCustomerListOptions): Promise<QuickBooksPage<QuickBooksCustomer>>
  listAll(options?: QuickBooksCustomerListOptions): AsyncIterable<QuickBooksCustomer>
}

export function createCustomersResource(http: QuickBooksWriteHttp): QuickBooksCustomersResource {
  const resource: QuickBooksCustomersResource = {
    async create(input, options) {
      createInput(input)
      nonEmpty(input.DisplayName, "DisplayName")
      return writeEntity(http, "Customer", "customer", input, options)
    },
    async update(input, options) {
      const identity = revision(input)
      if (input.DisplayName !== undefined) nonEmpty(input.DisplayName, "DisplayName")
      return writeEntity(
        http,
        "Customer",
        "customer",
        { ...input, ...identity, sparse: true },
        options,
        { id: input.Id }
      )
    },
    deactivate: async (input, options) =>
      resource.update({ ...revision(input), Active: false }, options),
    reactivate: async (input, options) =>
      resource.update({ ...revision(input), Active: true }, options),
    get: (id) => readEntity(http, "Customer", `customer/${pathId(id)}`, id),
    list: (options) => listEntities(http, "Customer", "DisplayName", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
