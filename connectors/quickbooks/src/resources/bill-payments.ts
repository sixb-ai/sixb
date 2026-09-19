import { listAll, listTransactions, pathId, readEntity } from "../query"
import type { QuickBooksBillPaymentListOptions, QuickBooksPage } from "../types/query"
import type { QuickBooksBillPayment } from "../types/transactions"
import type {
  QuickBooksBillPaymentCreate,
  QuickBooksBillPaymentUpdate,
  QuickBooksDeleteResult,
  QuickBooksRevision,
  QuickBooksWriteOptions,
} from "../types/writes"
import {
  createInput,
  deleteEntity,
  type QuickBooksWriteHttp,
  revision,
  updateEntity,
  writeEntity,
} from "../write"
import { billPayment } from "../write-validation"

export interface QuickBooksBillPaymentsResource {
  create(
    input: QuickBooksBillPaymentCreate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksBillPayment>
  update(
    input: QuickBooksBillPaymentUpdate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksBillPayment>
  delete(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksDeleteResult>
  void(input: QuickBooksRevision, options?: QuickBooksWriteOptions): Promise<QuickBooksBillPayment>
  /** GET /v3/company/{realmId}/billpayment/{id} */
  get(id: string): Promise<QuickBooksBillPayment>
  list(options?: QuickBooksBillPaymentListOptions): Promise<QuickBooksPage<QuickBooksBillPayment>>
  listAll(options?: QuickBooksBillPaymentListOptions): AsyncIterable<QuickBooksBillPayment>
}

export function createBillPaymentsResource(
  http: QuickBooksWriteHttp
): QuickBooksBillPaymentsResource {
  const resource: QuickBooksBillPaymentsResource = {
    async create(input, options) {
      createInput(input)
      billPayment(input)
      return writeEntity(http, "BillPayment", "billpayment", input, options)
    },
    async update(input, options) {
      billPayment(input)
      return updateEntity(http, "BillPayment", input, options)
    },
    delete: async (input, options) => deleteEntity(http, "BillPayment", input, options),
    async void(input, options) {
      return writeEntity(
        http,
        "BillPayment",
        "billpayment?operation=update&include=void",
        { ...revision(input), sparse: true },
        options,
        { id: input.Id }
      )
    },
    get: (id) => readEntity(http, "BillPayment", `billpayment/${pathId(id)}`, id),
    list: (options) => listTransactions(http, "BillPayment", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
