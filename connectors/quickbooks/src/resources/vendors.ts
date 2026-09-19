import { listAll, listEntities, pathId, readEntity } from "../query"
import type { QuickBooksVendor } from "../types/entities"
import type { QuickBooksPage, QuickBooksVendorListOptions } from "../types/query"
import type {
  QuickBooksRevision,
  QuickBooksVendorCreate,
  QuickBooksVendorUpdate,
  QuickBooksWriteOptions,
} from "../types/writes"
import { nonEmpty } from "../validation"
import { createInput, type QuickBooksWriteHttp, revision, writeEntity } from "../write"

export interface QuickBooksVendorsResource {
  create(input: QuickBooksVendorCreate, options?: QuickBooksWriteOptions): Promise<QuickBooksVendor>
  update(input: QuickBooksVendorUpdate, options?: QuickBooksWriteOptions): Promise<QuickBooksVendor>
  deactivate(input: QuickBooksRevision, options?: QuickBooksWriteOptions): Promise<QuickBooksVendor>
  reactivate(input: QuickBooksRevision, options?: QuickBooksWriteOptions): Promise<QuickBooksVendor>
  get(id: string): Promise<QuickBooksVendor>
  list(options?: QuickBooksVendorListOptions): Promise<QuickBooksPage<QuickBooksVendor>>
  listAll(options?: QuickBooksVendorListOptions): AsyncIterable<QuickBooksVendor>
}

export function createVendorsResource(http: QuickBooksWriteHttp): QuickBooksVendorsResource {
  const resource: QuickBooksVendorsResource = {
    async create(input, options) {
      createInput(input)
      nonEmpty(input.DisplayName, "DisplayName")
      return writeEntity(http, "Vendor", "vendor", input, options)
    },
    async update(input, options) {
      const identity = revision(input)
      if (input.DisplayName !== undefined) nonEmpty(input.DisplayName, "DisplayName")
      return writeEntity(
        http,
        "Vendor",
        "vendor",
        { ...input, ...identity, sparse: true },
        options,
        { id: input.Id }
      )
    },
    deactivate: async (input, options) =>
      resource.update({ ...revision(input), Active: false }, options),
    reactivate: async (input, options) =>
      resource.update({ ...revision(input), Active: true }, options),
    get: (id) => readEntity(http, "Vendor", `vendor/${pathId(id)}`, id),
    list: (options) => listEntities(http, "Vendor", "DisplayName", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
