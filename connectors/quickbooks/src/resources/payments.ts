import { listAll, listTransactions, pathId, readEntity } from "../query"
import type { QuickBooksPage, QuickBooksPaymentListOptions } from "../types/query"
import type { QuickBooksPayment } from "../types/transactions"
import type {
  QuickBooksDeleteResult,
  QuickBooksPaymentCreate,
  QuickBooksPaymentSendOptions,
  QuickBooksPaymentUpdate,
  QuickBooksRevision,
  QuickBooksWriteOptions,
} from "../types/writes"
import { nonEmpty } from "../validation"
import {
  createInput,
  deleteEntity,
  finiteAmount,
  type QuickBooksWriteHttp,
  revision,
  sendEntity,
  updateEntity,
  writeEntity,
} from "../write"
import { allocations } from "../write-validation"

export interface QuickBooksPaymentsResource {
  create(
    input: QuickBooksPaymentCreate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksPayment>
  /** Sparse update; Line replaces all allocations when supplied, including an empty array. */
  update(
    input: QuickBooksPaymentUpdate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksPayment>
  delete(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksDeleteResult>
  void(input: QuickBooksRevision, options?: QuickBooksWriteOptions): Promise<QuickBooksPayment>
  send(id: string, options: QuickBooksPaymentSendOptions): Promise<QuickBooksPayment>
  /** GET /v3/company/{realmId}/payment/{id} */
  get(id: string): Promise<QuickBooksPayment>
  list(options?: QuickBooksPaymentListOptions): Promise<QuickBooksPage<QuickBooksPayment>>
  listAll(options?: QuickBooksPaymentListOptions): AsyncIterable<QuickBooksPayment>
}

export function createPaymentsResource(http: QuickBooksWriteHttp): QuickBooksPaymentsResource {
  const resource: QuickBooksPaymentsResource = {
    async create(input, options) {
      createInput(input)
      nonEmpty(input.CustomerRef?.value, "CustomerRef.value")
      finiteAmount(input.TotalAmt)
      if (input.Line !== undefined) allocations(input.Line)
      return writeEntity(http, "Payment", "payment", input, options)
    },
    async update(input, options) {
      revision(input)
      if (input.CustomerRef !== undefined) nonEmpty(input.CustomerRef.value, "CustomerRef.value")
      if (input.TotalAmt !== undefined) finiteAmount(input.TotalAmt)
      if (input.Line !== undefined) allocations(input.Line)
      return updateEntity(http, "Payment", input, options)
    },
    delete: async (input, options) => deleteEntity(http, "Payment", input, options),
    async void(input, options) {
      return writeEntity(
        http,
        "Payment",
        "payment?operation=update&include=void",
        { ...revision(input), sparse: true },
        options,
        { id: input.Id }
      )
    },
    async send(id, options) {
      nonEmpty(options?.sendTo, "sendTo")
      return sendEntity(http, "Payment", id, options)
    },
    get: (id) => readEntity(http, "Payment", `payment/${pathId(id)}`, id),
    list: (options) => listTransactions(http, "Payment", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
