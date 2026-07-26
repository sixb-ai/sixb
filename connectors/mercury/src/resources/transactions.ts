import type { MercuryHttp } from "../http"
import { listAllCursor, listAllOffset } from "../pagination"
import { cursorQuery } from "../query"
import type {
  MercuryAccountTransactionListOptions,
  MercuryAccountTransactionsResponse,
  MercuryTransaction,
  MercuryTransactionListOptions,
  MercuryTransactionsResponse,
  MercuryUpdateTransactionInput,
  QueryParams,
} from "../types"
import { assertLimit, assertOffset, assertTransactionCursorOptions, pathId } from "../validation"

export interface TransactionsResource {
  /** `GET /transactions` — every account, cursor-paginated. */
  list(options?: MercuryTransactionListOptions): Promise<MercuryTransactionsResponse>
  /** Cursor iterator over `GET /transactions`. */
  listAll(options?: MercuryTransactionListOptions): AsyncIterable<MercuryTransaction>
  /** `GET /transaction/{transactionId}` */
  get(transactionId: string): Promise<MercuryTransaction>
  /** `PATCH /transaction/{transactionId}` — updates the note and custom category only. */
  update(transactionId: string, input: MercuryUpdateTransactionInput): Promise<MercuryTransaction>
  /** `GET /account/{accountId}/transactions` — offset-paginated, defaults to the last 30 days. */
  listForAccount(
    accountId: string,
    options?: MercuryAccountTransactionListOptions
  ): Promise<MercuryAccountTransactionsResponse>
  /** Offset iterator over `GET /account/{accountId}/transactions`. */
  listAllForAccount(
    accountId: string,
    options?: MercuryAccountTransactionListOptions
  ): AsyncIterable<MercuryTransaction>
  /** `GET /account/{accountId}/transaction/{transactionId}` */
  getForAccount(accountId: string, transactionId: string): Promise<MercuryTransaction>
}

export function createTransactionsResource(http: MercuryHttp): TransactionsResource {
  const resource: TransactionsResource = {
    list(options) {
      assertTransactionCursorOptions(options)
      return http.get("transactions", transactionListQuery(options))
    },
    listAll(options) {
      return listAllCursor(resource.list, (page) => page.transactions, options)
    },
    get(transactionId) {
      return http.get(`transaction/${pathId(transactionId, "transaction id")}`)
    },
    update(transactionId, input) {
      return http.patch(
        `transaction/${pathId(transactionId, "transaction id")}`,
        updateTransactionBody(input)
      )
    },
    listForAccount(accountId, options) {
      assertAccountTransactionOptions(options)
      return http.get(
        `account/${pathId(accountId, "account id")}/transactions`,
        accountTransactionListQuery(options)
      )
    },
    listAllForAccount(accountId, options) {
      return listAllOffset(
        (pageOptions) => resource.listForAccount(accountId, pageOptions),
        (page) => page.transactions,
        (page) => page.total,
        options
      )
    },
    getForAccount(accountId, transactionId) {
      return http.get(
        `account/${pathId(accountId, "account id")}/transaction/${pathId(
          transactionId,
          "transaction id"
        )}`
      )
    },
  }

  return resource
}

function transactionListQuery(options?: MercuryTransactionListOptions): QueryParams {
  return {
    ...cursorQuery(options),
    start_at: options?.start_at,
    status: options?.status,
    search: options?.search,
    start: options?.start,
    end: options?.end,
    postedStart: options?.postedStart,
    postedEnd: options?.postedEnd,
    accountId: options?.accountId,
    cardId: options?.cardId,
    mercuryCategory: options?.mercuryCategory,
    categoryId: options?.categoryId,
  }
}

function accountTransactionListQuery(options?: MercuryAccountTransactionListOptions): QueryParams {
  return {
    limit: options?.limit,
    order: options?.order,
    offset: options?.offset,
    start: options?.start,
    end: options?.end,
    search: options?.search,
    status: options?.status,
    requestId: options?.requestId,
    mercuryCategory: options?.mercuryCategory,
    categoryId: options?.categoryId,
  }
}

/**
 * Sends only the fields the caller supplied. Mercury treats an omitted field as "leave unchanged"
 * and an explicit `null` as "clear", so spreading the whole input would wipe the note whenever a
 * caller only meant to set the category.
 */
function updateTransactionBody(input: MercuryUpdateTransactionInput): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if ("note" in input) {
    body.note = input.note
  }
  if ("categoryId" in input) {
    body.categoryId = input.categoryId
  }

  if (Object.keys(body).length === 0) {
    throw new Error("[SixbMercury] update requires at least one of note or categoryId.")
  }

  return body
}

function assertAccountTransactionOptions(
  options: MercuryAccountTransactionListOptions | undefined
): void {
  if (options?.limit !== undefined) {
    assertLimit(options.limit)
  }
  if (options?.offset !== undefined) {
    assertOffset(options.offset)
  }
}
