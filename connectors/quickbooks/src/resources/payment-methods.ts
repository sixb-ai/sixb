import { listAll, listEntities, pathId, readEntity } from "../query"
import type { QuickBooksPaymentMethod } from "../types/entities"
import type { QuickBooksPage, QuickBooksPaymentMethodListOptions } from "../types/query"
import type {
  QuickBooksPaymentMethodCreate,
  QuickBooksPaymentMethodUpdate,
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

/** Payment methods are deactivated, not deleted. */
export interface QuickBooksPaymentMethodsResource {
  create(
    input: QuickBooksPaymentMethodCreate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksPaymentMethod>
  /** Sparse update using the caller's current SyncToken. */
  update(
    input: QuickBooksPaymentMethodUpdate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksPaymentMethod>
  deactivate(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksPaymentMethod>
  reactivate(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksPaymentMethod>
  /** GET /v3/company/{realmId}/paymentmethod/{id} */
  get(id: string): Promise<QuickBooksPaymentMethod>
  list(
    options?: QuickBooksPaymentMethodListOptions
  ): Promise<QuickBooksPage<QuickBooksPaymentMethod>>
  listAll(options?: QuickBooksPaymentMethodListOptions): AsyncIterable<QuickBooksPaymentMethod>
}

export function createPaymentMethodsResource(
  http: QuickBooksWriteHttp
): QuickBooksPaymentMethodsResource {
  const resource: QuickBooksPaymentMethodsResource = {
    async create(input, options) {
      createInput(input)
      nonEmpty(input.Name, "Name")
      paymentMethodType(input.Type)
      return writeEntity(http, "PaymentMethod", "paymentmethod", input, options)
    },
    async update(input, options) {
      if (input.Name !== undefined) nonEmpty(input.Name, "Name")
      paymentMethodType(input.Type)
      return updateEntity(http, "PaymentMethod", input, options)
    },
    deactivate: async (input, options) =>
      resource.update({ ...revision(input), Active: false }, options),
    reactivate: async (input, options) =>
      resource.update({ ...revision(input), Active: true }, options),
    get: (id) => readEntity(http, "PaymentMethod", `paymentmethod/${pathId(id)}`, id),
    list: (options) => listEntities(http, "PaymentMethod", "Name", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}

function paymentMethodType(value: unknown) {
  if (value !== undefined && value !== "CREDIT_CARD" && value !== "NON_CREDIT_CARD")
    throw new Error("[SixbQuickBooks] PaymentMethod Type must be CREDIT_CARD or NON_CREDIT_CARD.")
}
