import { listAll, listTransactions, pathId, readEntity } from "../query"
import type { QuickBooksPage, QuickBooksTimeActivityListOptions } from "../types/query"
import type { QuickBooksTimeActivity } from "../types/transactions"
import type {
  QuickBooksDeleteResult,
  QuickBooksRevision,
  QuickBooksTimeActivityCreate,
  QuickBooksTimeActivityUpdate,
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
import { timeActivity } from "../write-validation"

export interface QuickBooksTimeActivitiesResource {
  create(
    input: QuickBooksTimeActivityCreate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksTimeActivity>
  update(
    input: QuickBooksTimeActivityUpdate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksTimeActivity>
  delete(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksDeleteResult>
  /** GET /v3/company/{realmId}/timeactivity/{id} */
  get(id: string): Promise<QuickBooksTimeActivity>
  list(options?: QuickBooksTimeActivityListOptions): Promise<QuickBooksPage<QuickBooksTimeActivity>>
  listAll(options?: QuickBooksTimeActivityListOptions): AsyncIterable<QuickBooksTimeActivity>
}

export function createTimeActivitiesResource(
  http: QuickBooksWriteHttp
): QuickBooksTimeActivitiesResource {
  const resource: QuickBooksTimeActivitiesResource = {
    async create(input, options) {
      createInput(input)
      timeActivity(input, true)
      return writeEntity(http, "TimeActivity", "timeactivity", input, options)
    },
    async update(input, options) {
      revision(input)
      timeActivity(input, false)
      return updateEntity(http, "TimeActivity", input, options)
    },
    delete: async (input, options) => deleteEntity(http, "TimeActivity", input, options),
    get: (id) => readEntity(http, "TimeActivity", `timeactivity/${pathId(id)}`, id),
    list: (options) =>
      listTransactions(http, "TimeActivity", options, { party: "customer", docNumber: false }),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
