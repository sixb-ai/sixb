import { listAll, listEntities, pathId, readEntity } from "../query"
import type { QuickBooksAccount } from "../types/entities"
import type { QuickBooksAccountListOptions, QuickBooksPage } from "../types/query"
import type {
  QuickBooksAccountCreate,
  QuickBooksAccountUpdate,
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

export interface QuickBooksAccountsResource {
  create(
    input: QuickBooksAccountCreate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksAccount>
  update(
    input: QuickBooksAccountUpdate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksAccount>
  deactivate(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksAccount>
  reactivate(
    input: QuickBooksRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksAccount>
  get(id: string): Promise<QuickBooksAccount>
  list(options?: QuickBooksAccountListOptions): Promise<QuickBooksPage<QuickBooksAccount>>
  listAll(options?: QuickBooksAccountListOptions): AsyncIterable<QuickBooksAccount>
}

export function createAccountsResource(http: QuickBooksWriteHttp): QuickBooksAccountsResource {
  const resource: QuickBooksAccountsResource = {
    async create(input, options) {
      createInput(input)
      nonEmpty(input.Name, "Name")
      if (input.AccountType === undefined && input.AccountSubType === undefined)
        throw new Error("[SixbQuickBooks] AccountType or AccountSubType is required.")
      if (input.AccountType !== undefined) nonEmpty(input.AccountType, "AccountType")
      if (input.AccountSubType !== undefined) nonEmpty(input.AccountSubType, "AccountSubType")
      return writeEntity(http, "Account", "account", input, options)
    },
    async update(input, options) {
      if (input.Name !== undefined) nonEmpty(input.Name, "Name")
      return updateEntity(http, "Account", input, options)
    },
    deactivate: async (input, options) =>
      resource.update({ ...revision(input), Active: false }, options),
    reactivate: async (input, options) =>
      resource.update({ ...revision(input), Active: true }, options),
    get: (id) => readEntity(http, "Account", `account/${pathId(id)}`, id),
    list: (options) => listEntities(http, "Account", "Name", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}
