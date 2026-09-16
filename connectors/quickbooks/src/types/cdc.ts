import type {
  QuickBooksAccount,
  QuickBooksCustomer,
  QuickBooksItem,
  QuickBooksTerm,
  QuickBooksVendor,
} from "./entities"
import type {
  QuickBooksBill,
  QuickBooksBillPayment,
  QuickBooksCreditMemo,
  QuickBooksInvoice,
  QuickBooksPayment,
  QuickBooksVendorCredit,
} from "./transactions"

export interface QuickBooksCdcEntityMap {
  readonly Account: QuickBooksAccount
  readonly Customer: QuickBooksCustomer
  readonly Item: QuickBooksItem
  readonly Term: QuickBooksTerm
  readonly Vendor: QuickBooksVendor
  readonly Invoice: QuickBooksInvoice
  readonly Payment: QuickBooksPayment
  readonly CreditMemo: QuickBooksCreditMemo
  readonly Bill: QuickBooksBill
  readonly BillPayment: QuickBooksBillPayment
  readonly VendorCredit: QuickBooksVendorCredit
}

export type QuickBooksCdcEntity = keyof QuickBooksCdcEntityMap

export interface QuickBooksDeletedEntity {
  readonly Id: string
  readonly status: "Deleted"
  readonly domain?: string
  readonly MetaData?: { readonly LastUpdatedTime?: string }
}

export type QuickBooksCdcChange<T> = (T & { readonly status?: never }) | QuickBooksDeletedEntity

export type QuickBooksCdcQueryResponse = {
  readonly [K in QuickBooksCdcEntity]?: readonly QuickBooksCdcChange<QuickBooksCdcEntityMap[K]>[]
} & {
  readonly startPosition?: number
  readonly maxResults?: number
  readonly totalCount?: number
}

export interface QuickBooksCdcResponse {
  readonly CDCResponse: readonly { readonly QueryResponse: readonly QuickBooksCdcQueryResponse[] }[]
  readonly time: string
}

export interface QuickBooksCdcOptions {
  readonly entities: readonly QuickBooksCdcEntity[]
  /** Must be in the past and no more than 30 days old. */
  readonly changedSince: Date
}
