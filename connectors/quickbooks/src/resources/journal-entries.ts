import { listAll, listTransactions, pathId, readEntity } from "../query"
import type { QuickBooksJournalEntryListOptions, QuickBooksPage } from "../types/query"
import type { QuickBooksJournalEntry } from "../types/transactions"
import type {
  QuickBooksDeleteResult,
  QuickBooksJournalEntryCreate,
  QuickBooksJournalEntryUpdate,
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
import { journalLines } from "../write-validation"

/** Debits must equal credits; QuickBooks validates the balance. */
export interface QuickBooksJournalEntriesResource {
  create(
    input: QuickBooksJournalEntryCreate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksJournalEntry>
  update(
    input: QuickBooksJournalEntryUpdate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksJournalEntry>
  delete(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksDeleteResult>
  /** GET /v3/company/{realmId}/journalentry/{id} */
  get(id: string): Promise<QuickBooksJournalEntry>
  list(options?: QuickBooksJournalEntryListOptions): Promise<QuickBooksPage<QuickBooksJournalEntry>>
  listAll(options?: QuickBooksJournalEntryListOptions): AsyncIterable<QuickBooksJournalEntry>
}

export function createJournalEntriesResource(
  http: QuickBooksWriteHttp
): QuickBooksJournalEntriesResource {
  const resource: QuickBooksJournalEntriesResource = {
    async create(input, options) {
      createInput(input)
      journalLines(input.Line)
      return writeEntity(http, "JournalEntry", "journalentry", input, options)
    },
    async update(input, options) {
      revision(input)
      if (input.Line !== undefined) journalLines(input.Line)
      return updateEntity(http, "JournalEntry", input, options)
    },
    delete: async (input, options) => deleteEntity(http, "JournalEntry", input, options),
    get: (id) => readEntity(http, "JournalEntry", `journalentry/${pathId(id)}`, id),
    list: (options) => listTransactions(http, "JournalEntry", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
