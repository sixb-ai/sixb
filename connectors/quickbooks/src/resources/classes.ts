import { listAll, listEntities, pathId, readEntity } from "../query"
import type { QuickBooksClass } from "../types/entities"
import type { QuickBooksClassListOptions, QuickBooksPage } from "../types/query"
import type {
  QuickBooksClassCreate,
  QuickBooksClassRevision,
  QuickBooksClassUpdate,
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

/** Classes are deactivated, not deleted. */
export interface QuickBooksClassesResource {
  create(input: QuickBooksClassCreate, options?: QuickBooksWriteOptions): Promise<QuickBooksClass>
  /** Sparse update using the caller's current SyncToken; Name is always required. */
  update(input: QuickBooksClassUpdate, options?: QuickBooksWriteOptions): Promise<QuickBooksClass>
  deactivate(
    input: QuickBooksClassRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksClass>
  reactivate(
    input: QuickBooksClassRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksClass>
  /** GET /v3/company/{realmId}/class/{id} */
  get(id: string): Promise<QuickBooksClass>
  list(options?: QuickBooksClassListOptions): Promise<QuickBooksPage<QuickBooksClass>>
  listAll(options?: QuickBooksClassListOptions): AsyncIterable<QuickBooksClass>
}

export function createClassesResource(http: QuickBooksWriteHttp): QuickBooksClassesResource {
  const resource: QuickBooksClassesResource = {
    async create(input, options) {
      createInput(input)
      nonEmpty(input.Name, "Name")
      parent(input.SubClass, input.ParentRef)
      return writeEntity(http, "Class", "class", input, options)
    },
    async update(input, options) {
      nonEmpty(input.Name, "Name")
      parent(input.SubClass, input.ParentRef)
      return updateEntity(http, "Class", input, options)
    },
    deactivate: async (input, options) =>
      resource.update({ ...revision(input), Name: input.Name, Active: false }, options),
    reactivate: async (input, options) =>
      resource.update({ ...revision(input), Name: input.Name, Active: true }, options),
    get: (id) => readEntity(http, "Class", `class/${pathId(id)}`, id),
    list: (options) => listEntities(http, "Class", "Name", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}

function parent(sub: boolean | undefined, ref: { value: string } | undefined) {
  if (sub === true) nonEmpty(ref?.value, "ParentRef.value")
}
