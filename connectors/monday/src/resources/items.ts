import type { MondayHttp } from "../http"
import type {
  MondayChangeColumnsParameters,
  MondayColumnWrites,
  MondayCreateItemParameters,
  MondayCreateSubitemParameters,
  MondayItem,
  MondayItemListOptions,
  MondayItemPage,
  MondayItemReadOptions,
  MondayItemReference,
  MondayRequestOptions,
  MondayWriteOptions,
} from "../types"
import { columnIds, entities, entity, id, integer, nonEmpty, record, required } from "../validation"

const fields = `id name url created_at updated_at board { id } parent_item { id }
  group { id title } column_values(ids: $column_ids) { id type text value }`
const referenceFields = "id board { id }"
function values(input: MondayColumnWrites): string {
  if (!record(input) || Object.keys(input).length === 0)
    throw new Error("[SixbMonday] column_values must contain at least one column.")
  for (const [key, value] of Object.entries(input)) {
    nonEmpty(key, "column ID")
    if (value === undefined || (value !== null && typeof value !== "string" && !record(value)))
      throw new Error("[SixbMonday] Column values must use a supported write shape.")
  }
  // Reject values that JSON.stringify would silently discard or coerce (undefined/NaN/etc.).
  return JSON.stringify(input, (_key, value: unknown) => {
    if (
      value === undefined ||
      typeof value === "function" ||
      typeof value === "symbol" ||
      (typeof value === "number" && !Number.isFinite(value))
    )
      throw new Error("[SixbMonday] Column values must be JSON serializable without data loss.")
    return value
  })
}
function itemPage(value: unknown): MondayItemPage {
  if (!record(value) || !(value.cursor === null || typeof value.cursor === "string"))
    throw new Error("[SixbMonday] Invalid items page in API response.")
  return { cursor: value.cursor, items: entities<MondayItem>(value.items) }
}
export function itemResources(http: MondayHttp) {
  async function get(
    itemId: string,
    parameters: MondayItemReadOptions = {},
    options?: MondayRequestOptions
  ): Promise<MondayItem | null> {
    const data = await http.read(
      `query ($ids: [ID!], $column_ids: [String!]) {
      items(ids: $ids) { ${fields} }
    }`,
      { ids: [id(itemId)], column_ids: columnIds(parameters.column_ids) },
      options
    )
    return entities<MondayItem>(data.items)[0] ?? null
  }
  async function list(
    parameters: MondayItemListOptions,
    options?: MondayRequestOptions
  ): Promise<MondayItemPage> {
    const data = await http.read(
      `query ($ids: [ID!], $limit: Int!, $query_params: ItemsQuery, $column_ids: [String!]) {
      boards(ids: $ids) { id items_page(limit: $limit, query_params: $query_params) { cursor items { ${fields} } } }
    }`,
      {
        ids: [id(parameters.board_id)],
        limit: integer(parameters.limit ?? 50, "limit", 1, 500),
        query_params: parameters.query_params,
        column_ids: columnIds(parameters.column_ids),
      },
      options
    )
    const board = required(entities<Record<string, unknown>>(data.boards)[0], "Board")
    return itemPage(board.items_page)
  }
  async function nextPage(
    parameters: { cursor: string; limit?: number; column_ids?: readonly string[] },
    options?: MondayRequestOptions
  ): Promise<MondayItemPage> {
    const data = await http.read(
      `query ($cursor: String!, $limit: Int!, $column_ids: [String!]) {
      next_items_page(cursor: $cursor, limit: $limit) { cursor items { ${fields} } }
    }`,
      {
        cursor: nonEmpty(parameters.cursor, "cursor"),
        limit: integer(parameters.limit ?? 50, "limit", 1, 500),
        column_ids: columnIds(parameters.column_ids),
      },
      options
    )
    return itemPage(data.next_items_page)
  }
  async function children(
    parentId: string,
    parameters: MondayItemReadOptions = {},
    options?: MondayRequestOptions
  ): Promise<MondayItem[]> {
    const data = await http.read(
      `query ($ids: [ID!], $column_ids: [String!]) {
      items(ids: $ids) { id subitems { ${fields} } }
    }`,
      { ids: [id(parentId)], column_ids: columnIds(parameters.column_ids) },
      options
    )
    const parent = required(entities<Record<string, unknown>>(data.items)[0], "Parent item")
    return entities<MondayItem>(parent.subitems)
  }
  return {
    items: {
      get,
      list,
      nextPage,
      async *listAll(
        parameters: MondayItemListOptions,
        options?: MondayRequestOptions
      ): AsyncIterable<MondayItem> {
        let page = await list(parameters, options)
        const seen = new Set<string>()
        for (;;) {
          yield* page.items
          if (page.cursor === null) return
          if (seen.has(page.cursor)) throw new Error("[SixbMonday] Repeated pagination cursor.")
          seen.add(page.cursor)
          page = await nextPage(
            { cursor: page.cursor, limit: parameters.limit, column_ids: parameters.column_ids },
            options
          )
        }
      },
      async create(
        parameters: MondayCreateItemParameters,
        options?: MondayWriteOptions
      ): Promise<MondayItemReference> {
        const data = await http.write(
          `mutation ($board_id: ID!, $group_id: String, $item_name: String!, $column_values: JSON) {
          create_item(board_id: $board_id, group_id: $group_id, item_name: $item_name, column_values: $column_values,
            create_labels_if_missing: false) { ${referenceFields} }
        }`,
          {
            board_id: id(parameters.board_id),
            group_id:
              parameters.group_id === undefined
                ? undefined
                : nonEmpty(parameters.group_id, "group_id"),
            item_name: nonEmpty(parameters.item_name, "item_name"),
            column_values:
              parameters.column_values === undefined ? undefined : values(parameters.column_values),
          },
          options
        )
        return entity<MondayItemReference>(data.create_item)
      },
      async changeColumns(
        parameters: MondayChangeColumnsParameters,
        options?: MondayWriteOptions
      ): Promise<MondayItemReference> {
        const data = await http.write(
          `mutation ($board_id: ID!, $item_id: ID!, $column_values: JSON!) {
          change_multiple_column_values(board_id: $board_id, item_id: $item_id, column_values: $column_values,
            create_labels_if_missing: false) { ${referenceFields} }
        }`,
          {
            board_id: id(parameters.board_id),
            item_id: id(parameters.item_id),
            column_values: values(parameters.column_values),
          },
          options
        )
        return entity<MondayItemReference>(data.change_multiple_column_values)
      },
      async rename(
        parameters: { board_id: string; item_id: string; name: string },
        options?: MondayWriteOptions
      ): Promise<MondayItemReference> {
        const data = await http.write(
          `mutation ($board_id: ID!, $item_id: ID!, $name: String!) {
          change_simple_column_value(board_id: $board_id, item_id: $item_id, column_id: "name", value: $name) { ${referenceFields} }
        }`,
          {
            board_id: id(parameters.board_id),
            item_id: id(parameters.item_id),
            name: nonEmpty(parameters.name, "name"),
          },
          options
        )
        return entity<MondayItemReference>(data.change_simple_column_value)
      },
      async moveToGroup(
        parameters: { item_id: string; group_id: string },
        options?: MondayWriteOptions
      ): Promise<MondayItemReference> {
        const data = await http.write(
          `mutation ($item_id: ID!, $group_id: String!) {
          move_item_to_group(item_id: $item_id, group_id: $group_id) { ${referenceFields} }
        }`,
          { item_id: id(parameters.item_id), group_id: nonEmpty(parameters.group_id, "group_id") },
          options
        )
        return entity<MondayItemReference>(data.move_item_to_group)
      },
    },
    subitems: {
      /** Returns immediate children without imposing a client-side cap. */
      list: children,
      /** Walk all descendants. Classic boards have one level; multi-level boards can have more. */
      async *listAll(
        parentId: string,
        parameters: MondayItemReadOptions = {},
        options?: MondayRequestOptions
      ): AsyncIterable<MondayItem> {
        const pending = [id(parentId)]
        const seen = new Set(pending)
        while (pending.length) {
          const parent = pending.pop()
          if (!parent) break
          for (const item of await children(parent, parameters, options)) {
            if (seen.has(item.id))
              throw new Error("[SixbMonday] Repeated item in subitem hierarchy.")
            seen.add(item.id)
            yield item
            pending.push(item.id)
          }
        }
      },
      async create(
        parameters: MondayCreateSubitemParameters,
        options?: MondayWriteOptions
      ): Promise<MondayItemReference> {
        const data = await http.write(
          `mutation ($parent_item_id: ID!, $item_name: String!, $column_values: JSON) {
          create_subitem(parent_item_id: $parent_item_id, item_name: $item_name, column_values: $column_values,
            create_labels_if_missing: false) { ${referenceFields} }
        }`,
          {
            parent_item_id: id(parameters.parent_item_id),
            item_name: nonEmpty(parameters.item_name, "item_name"),
            column_values:
              parameters.column_values === undefined ? undefined : values(parameters.column_values),
          },
          options
        )
        return entity<MondayItemReference>(data.create_subitem)
      },
    },
  }
}
