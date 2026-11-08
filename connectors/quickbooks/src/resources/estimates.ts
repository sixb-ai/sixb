import { listAll, listTransactions, pathId, readEntity } from "../query"
import type { QuickBooksEstimateListOptions, QuickBooksPage } from "../types/query"
import type { QuickBooksEstimate } from "../types/transactions"
import type {
  QuickBooksDeleteResult,
  QuickBooksEstimateCreate,
  QuickBooksEstimateSendOptions,
  QuickBooksEstimateUpdate,
  QuickBooksRevision,
  QuickBooksWriteOptions,
} from "../types/writes"
import { nonEmpty } from "../validation"
import {
  createInput,
  deleteEntity,
  type QuickBooksPdfHttp,
  revision,
  sendEntity,
  updateEntity,
  writeEntity,
} from "../write"
import { estimateStatus, salesLines } from "../write-validation"

export interface QuickBooksEstimatesResource {
  create(
    input: QuickBooksEstimateCreate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksEstimate>
  /** Sparse update, including TxnStatus, acceptance fields and line edits by line ID. */
  update(
    input: QuickBooksEstimateUpdate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksEstimate>
  /** Estimates cannot be voided; delete them instead. */
  delete(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksDeleteResult>
  send(id: string, options?: QuickBooksEstimateSendOptions): Promise<QuickBooksEstimate>
  /** GET /v3/company/{realmId}/estimate/{id} */
  get(id: string): Promise<QuickBooksEstimate>
  /** GET /v3/company/{realmId}/estimate/{id}/pdf — PDF bytes using company form styles. */
  downloadPdf(id: string): Promise<Uint8Array<ArrayBuffer>>
  list(options?: QuickBooksEstimateListOptions): Promise<QuickBooksPage<QuickBooksEstimate>>
  listAll(options?: QuickBooksEstimateListOptions): AsyncIterable<QuickBooksEstimate>
}

export function createEstimatesResource(http: QuickBooksPdfHttp): QuickBooksEstimatesResource {
  const resource: QuickBooksEstimatesResource = {
    async create(input, options) {
      createInput(input)
      nonEmpty(input.CustomerRef?.value, "CustomerRef.value")
      salesLines(input.Line)
      estimateStatus(input.TxnStatus)
      return writeEntity(http, "Estimate", "estimate", input, options)
    },
    async update(input, options) {
      revision(input)
      if (input.CustomerRef !== undefined) nonEmpty(input.CustomerRef.value, "CustomerRef.value")
      if (input.Line !== undefined) salesLines(input.Line)
      estimateStatus(input.TxnStatus)
      return updateEntity(http, "Estimate", input, options)
    },
    delete: async (input, options) => deleteEntity(http, "Estimate", input, options),
    send: async (id, options) => sendEntity(http, "Estimate", id, options),
    get: (id) => readEntity(http, "Estimate", `estimate/${pathId(id)}`, id),
    downloadPdf: (id) => http.getPdf(`estimate/${pathId(id)}/pdf`),
    list: (options) => listTransactions(http, "Estimate", options, { party: "customer" }),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
