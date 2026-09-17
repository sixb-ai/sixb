import { listAll, listEntities, pathId, readEntity } from "../query"
import type { QuickBooksTerm } from "../types/entities"
import type { QuickBooksPage, QuickBooksTermListOptions } from "../types/query"
import type {
  QuickBooksRevision,
  QuickBooksTermCreate,
  QuickBooksTermUpdate,
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

export interface QuickBooksTermsResource {
  create(input: QuickBooksTermCreate, options?: QuickBooksWriteOptions): Promise<QuickBooksTerm>
  update(input: QuickBooksTermUpdate, options?: QuickBooksWriteOptions): Promise<QuickBooksTerm>
  deactivate(input: QuickBooksRevision, options?: QuickBooksWriteOptions): Promise<QuickBooksTerm>
  reactivate(input: QuickBooksRevision, options?: QuickBooksWriteOptions): Promise<QuickBooksTerm>
  get(id: string): Promise<QuickBooksTerm>
  list(options?: QuickBooksTermListOptions): Promise<QuickBooksPage<QuickBooksTerm>>
  listAll(options?: QuickBooksTermListOptions): AsyncIterable<QuickBooksTerm>
}

export function createTermsResource(http: QuickBooksWriteHttp): QuickBooksTermsResource {
  const resource: QuickBooksTermsResource = {
    async create(input, options) {
      createInput(input)
      nonEmpty(input.Name, "Name")
      if (input.DueDays === undefined && input.DayOfMonthDue === undefined)
        throw new Error("[SixbQuickBooks] DueDays or DayOfMonthDue is required.")
      validate(input)
      return writeEntity(http, "Term", "term", input, options)
    },
    async update(input, options) {
      if (input.DueDays === undefined && input.DayOfMonthDue === undefined)
        throw new Error("[SixbQuickBooks] Term updates require DueDays or DayOfMonthDue.")
      validate(input)
      return updateEntity(http, "Term", input, options)
    },
    async deactivate(input, options) {
      const update = { ...revision(input), Active: false }
      return updateEntity(http, "Term", update, options)
    },
    async reactivate(input, options) {
      const update = { ...revision(input), Active: true }
      return updateEntity(http, "Term", update, options)
    },
    get: (id) => readEntity(http, "Term", `term/${pathId(id)}`, id),
    list: (options) => listEntities(http, "Term", "Name", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}

function validate(input: Partial<QuickBooksTermCreate>) {
  if (input.Name !== undefined) nonEmpty(input.Name, "Name")
  if (input.DueDays !== undefined && input.DayOfMonthDue !== undefined)
    throw new Error("[SixbQuickBooks] Specify DueDays or DayOfMonthDue, not both.")
  for (const [field, min, max] of [
    ["DueDays", 0, 999],
    ["DiscountDays", 0, 999],
    ["DayOfMonthDue", 1, 31],
    ["DiscountDayOfMonth", 1, 31],
    ["DueNextMonthDays", 0, 999],
  ] as const) {
    const value = input[field]
    if (value !== undefined && (!Number.isInteger(value) || value < min || value > max))
      throw new Error(`[SixbQuickBooks] ${field} must be an integer from ${min} to ${max}.`)
  }
  if (
    input.DiscountPercent !== undefined &&
    (!Number.isFinite(input.DiscountPercent) ||
      input.DiscountPercent < 0 ||
      input.DiscountPercent > 100)
  )
    throw new Error("[SixbQuickBooks] DiscountPercent must be between 0 and 100.")
}
