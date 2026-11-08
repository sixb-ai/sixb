import { listAll, listEntities, pathId, readEntity } from "../query"
import type { QuickBooksDepartment } from "../types/entities"
import type { QuickBooksDepartmentListOptions, QuickBooksPage } from "../types/query"
import type {
  QuickBooksDepartmentCreate,
  QuickBooksDepartmentRevision,
  QuickBooksDepartmentUpdate,
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

/** Departments (Locations in the QuickBooks UI) are deactivated, not deleted. */
export interface QuickBooksDepartmentsResource {
  create(
    input: QuickBooksDepartmentCreate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksDepartment>
  /** Sparse update using the caller's current SyncToken; Name is always required. */
  update(
    input: QuickBooksDepartmentUpdate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksDepartment>
  deactivate(
    input: QuickBooksDepartmentRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksDepartment>
  reactivate(
    input: QuickBooksDepartmentRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksDepartment>
  /** GET /v3/company/{realmId}/department/{id} */
  get(id: string): Promise<QuickBooksDepartment>
  list(options?: QuickBooksDepartmentListOptions): Promise<QuickBooksPage<QuickBooksDepartment>>
  listAll(options?: QuickBooksDepartmentListOptions): AsyncIterable<QuickBooksDepartment>
}

export function createDepartmentsResource(
  http: QuickBooksWriteHttp
): QuickBooksDepartmentsResource {
  const resource: QuickBooksDepartmentsResource = {
    async create(input, options) {
      createInput(input)
      nonEmpty(input.Name, "Name")
      parent(input.SubDepartment, input.ParentRef)
      return writeEntity(http, "Department", "department", input, options)
    },
    async update(input, options) {
      nonEmpty(input.Name, "Name")
      parent(input.SubDepartment, input.ParentRef)
      return updateEntity(http, "Department", input, options)
    },
    deactivate: async (input, options) =>
      resource.update({ ...revision(input), Name: input.Name, Active: false }, options),
    reactivate: async (input, options) =>
      resource.update({ ...revision(input), Name: input.Name, Active: true }, options),
    get: (id) => readEntity(http, "Department", `department/${pathId(id)}`, id),
    list: (options) => listEntities(http, "Department", "Name", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}

function parent(sub: boolean | undefined, ref: { value: string } | undefined) {
  if (sub === true) nonEmpty(ref?.value, "ParentRef.value")
}
