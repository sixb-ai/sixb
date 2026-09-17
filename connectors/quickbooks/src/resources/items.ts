import { listAll, listEntities, pathId, readEntity } from "../query"
import type { QuickBooksItem } from "../types/entities"
import type { QuickBooksItemListOptions, QuickBooksPage } from "../types/query"
import type {
  QuickBooksItemCreate,
  QuickBooksItemRevision,
  QuickBooksItemUpdate,
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

export interface QuickBooksItemsResource {
  create(input: QuickBooksItemCreate, options?: QuickBooksWriteOptions): Promise<QuickBooksItem>
  update(input: QuickBooksItemUpdate, options?: QuickBooksWriteOptions): Promise<QuickBooksItem>
  /** Not supported for Category or Group items. */
  deactivate(
    input: QuickBooksItemRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksItem>
  reactivate(
    input: QuickBooksItemRevision,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksItem>
  get(id: string): Promise<QuickBooksItem>
  list(options?: QuickBooksItemListOptions): Promise<QuickBooksPage<QuickBooksItem>>
  listAll(options?: QuickBooksItemListOptions): AsyncIterable<QuickBooksItem>
}

export function createItemsResource(http: QuickBooksWriteHttp): QuickBooksItemsResource {
  const resource: QuickBooksItemsResource = {
    async create(input, options) {
      createInput(input)
      nonEmpty(input.Name, "Name")
      validate(input)
      if (input.Type !== "Category")
        nonEmpty(input.IncomeAccountRef?.value, "IncomeAccountRef.value")
      if (input.Type === "Inventory") {
        nonEmpty(input.ExpenseAccountRef?.value, "ExpenseAccountRef.value")
        nonEmpty(input.AssetAccountRef?.value, "AssetAccountRef.value")
        nonEmpty(input.InvStartDate, "InvStartDate")
        quantity(input.QtyOnHand)
        if (input.TrackQtyOnHand !== true)
          throw new Error("[SixbQuickBooks] Inventory requires TrackQtyOnHand: true.")
      }
      return writeEntity(http, "Item", "item", input, options)
    },
    async update(input, options) {
      validate(input)
      if (input.Name !== undefined) nonEmpty(input.Name, "Name")
      return updateEntity(http, "Item", input, options)
    },
    async deactivate(input, options) {
      activationType(input)
      return resource.update({ ...revision(input), Type: input.Type, Active: false }, options)
    },
    async reactivate(input, options) {
      activationType(input)
      return resource.update({ ...revision(input), Type: input.Type, Active: true }, options)
    },
    get: (id) => readEntity(http, "Item", `item/${pathId(id)}`, id),
    list: (options) => listEntities(http, "Item", "Name", options),
    listAll: (options) => listAll(resource.list, options),
  }
  return resource
}

function activationType(input: QuickBooksItemRevision) {
  if (!["Service", "NonInventory", "Inventory"].includes(input.Type))
    throw new Error(
      "[SixbQuickBooks] Only Service, NonInventory, and Inventory items support activation."
    )
}

function validate(input: QuickBooksItemCreate | QuickBooksItemUpdate) {
  if (!["Service", "NonInventory", "Inventory", "Category"].includes(input.Type))
    throw new Error("[SixbQuickBooks] Unsupported writable item Type.")
  if (input.Type === "Category" && "Active" in input)
    throw new Error("[SixbQuickBooks] Category activation is not supported.")
  if (input.Type === "Inventory" && input.QtyOnHand !== undefined) {
    quantity(input.QtyOnHand)
    nonEmpty(input.InvStartDate, "InvStartDate for inventory adjustment")
  }
  if (input.SubItem) nonEmpty(input.ParentRef?.value, "ParentRef.value")
}

function quantity(value: number) {
  if (!Number.isFinite(value)) throw new Error("[SixbQuickBooks] QtyOnHand must be finite.")
}
