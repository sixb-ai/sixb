import { listAll, listTransactions, pathId, type QuickBooksReadHttp, quoted } from "../query"
import type { QuickBooksPage, QuickBooksRecurringTransactionListOptions } from "../types/query"
import type {
  QuickBooksRecurringTemplateType,
  QuickBooksRecurringTransaction,
} from "../types/transactions"
import { isRecord, templateOf } from "../validation"

/**
 * Read-only recurring templates. Each record is wrapped under its template entity name and
 * identified by that template's Id (which differs from transactions' RecurDataRef values).
 */
export interface QuickBooksRecurringTransactionsResource {
  /** GET /v3/company/{realmId}/recurringtransaction/{id} */
  get(id: string): Promise<QuickBooksRecurringTransaction>
  list(
    options?: QuickBooksRecurringTransactionListOptions
  ): Promise<QuickBooksPage<QuickBooksRecurringTransaction>>
  listAll(
    options?: QuickBooksRecurringTransactionListOptions
  ): AsyncIterable<QuickBooksRecurringTransaction>
}

const TEMPLATE_TYPES = {
  Bill: true,
  CreditMemo: true,
  Deposit: true,
  Estimate: true,
  Invoice: true,
  JournalEntry: true,
  Purchase: true,
  PurchaseOrder: true,
  RefundReceipt: true,
  SalesReceipt: true,
  Transfer: true,
  VendorCredit: true,
} as const satisfies Record<QuickBooksRecurringTemplateType, true>

export function createRecurringTransactionsResource(
  http: QuickBooksReadHttp
): QuickBooksRecurringTransactionsResource {
  const resource: QuickBooksRecurringTransactionsResource = {
    get: (id) => readRecurring(http, `recurringtransaction/${pathId(id)}`, id),
    async list(options = {}) {
      const { type, ...query } = options
      if (type !== undefined && !Object.hasOwn(TEMPLATE_TYPES, type))
        throw new Error(
          `[SixbQuickBooks] Recurring transaction type must be one of: ${Object.keys(TEMPLATE_TYPES).join(", ")}.`
        )
      return listTransactions(
        http,
        "RecurringTransaction",
        query,
        { txnDate: false, docNumber: false },
        {
          clauses: type === undefined ? [] : [`Type = ${quoted(type)}`],
          validate: (item) => recurringTemplate(item),
        }
      )
    },
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}

async function readRecurring(
  http: QuickBooksReadHttp,
  path: string,
  id: string
): Promise<QuickBooksRecurringTransaction> {
  const body = await http.get(path)
  const wrapper = isRecord(body) ? body.RecurringTransaction : undefined
  if (recurringTemplate(wrapper).Id !== id)
    throw new Error("[SixbQuickBooks] RecurringTransaction response ID does not match the request.")
  return wrapper as QuickBooksRecurringTransaction
}

function recurringTemplate(value: unknown): Record<string, unknown> & { Id: string } {
  const template = templateOf(value)
  if (!template || typeof template.Id !== "string" || !template.Id.trim())
    throw new Error("[SixbQuickBooks] Invalid RecurringTransaction response.")
  return template as Record<string, unknown> & { Id: string }
}
