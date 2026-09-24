import type { MondayHttp } from "../http"
import { pages } from "../pagination"
import type {
  MondayAsset,
  MondayPageOptions,
  MondayRequestOptions,
  MondayUpdate,
  MondayUser,
  MondayWriteOptions,
} from "../types"
import { entities, entity, id, ids, integer, nonEmpty, required } from "../validation"

const updateFields = `id body text_body created_at updated_at creator_id
  replies { id body text_body created_at updated_at creator_id }`
const userFields = "id name kind status"
const assetFields = "id name file_extension file_size url public_url created_at"
export function supportingResources(http: MondayHttp) {
  async function updatesList(
    parameters: MondayPageOptions & { item_id: string },
    options?: MondayRequestOptions
  ): Promise<MondayUpdate[]> {
    const data = await http.read(
      `query ($ids: [ID!], $limit: Int!, $page: Int!) {
      items(ids: $ids) { id updates(limit: $limit, page: $page) { ${updateFields} } }
    }`,
      {
        ids: [id(parameters.item_id)],
        limit: integer(parameters.limit ?? 25, "limit", 1, 100),
        page: integer(parameters.page ?? 1, "page", 1),
      },
      options
    )
    return entities<MondayUpdate>(
      required(entities<Record<string, unknown>>(data.items)[0], "Item").updates
    )
  }
  async function usersList(
    parameters: MondayPageOptions = {},
    options?: MondayRequestOptions
  ): Promise<MondayUser[]> {
    const data = await http.read(
      `query ($limit: Int!, $page: Int!) { users(limit: $limit, page: $page) { ${userFields} } }`,
      {
        limit: integer(parameters.limit ?? 100, "limit", 1, 1000),
        page: integer(parameters.page ?? 1, "page", 1),
      },
      options
    )
    return entities<MondayUser>(data.users)
  }
  return {
    updates: {
      list: updatesList,
      listAll(
        parameters: MondayPageOptions & { item_id: string },
        options?: MondayRequestOptions
      ): AsyncIterable<MondayUpdate> {
        const limit = integer(parameters.limit ?? 25, "limit", 1, 100)
        return pages(
          (page) => updatesList({ ...parameters, limit, page }, options),
          integer(parameters.page ?? 1, "page", 1),
          limit
        )
      },
      async create(
        parameters: { item_id: string; body: string },
        options?: MondayWriteOptions
      ): Promise<MondayUpdate> {
        const data = await http.write(
          `mutation ($item_id: ID!, $body: String!) {
          create_update(item_id: $item_id, body: $body) { ${updateFields} }
        }`,
          { item_id: id(parameters.item_id), body: nonEmpty(parameters.body, "body") },
          options
        )
        return entity<MondayUpdate>(data.create_update)
      },
      async edit(
        parameters: { id: string; body: string },
        options?: MondayWriteOptions
      ): Promise<MondayUpdate> {
        const data = await http.write(
          `mutation ($id: ID!, $body: String!) {
          edit_update(id: $id, body: $body) { ${updateFields} }
        }`,
          { id: id(parameters.id), body: nonEmpty(parameters.body, "body") },
          options
        )
        return entity<MondayUpdate>(data.edit_update)
      },
    },
    users: {
      list: usersList,
      listAll(
        parameters: MondayPageOptions = {},
        options?: MondayRequestOptions
      ): AsyncIterable<MondayUser> {
        const limit = integer(parameters.limit ?? 100, "limit", 1, 1000)
        return pages(
          (page) => usersList({ ...parameters, limit, page }, options),
          integer(parameters.page ?? 1, "page", 1),
          limit
        )
      },
      async get(userId: string, options?: MondayRequestOptions): Promise<MondayUser | null> {
        const data = await http.read(
          `query ($ids: [ID!]) { users(ids: $ids) { ${userFields} } }`,
          { ids: [id(userId)] },
          options
        )
        return entities<MondayUser>(data.users)[0] ?? null
      },
    },
    assets: {
      async get(assetId: string, options?: MondayRequestOptions): Promise<MondayAsset | null> {
        const data = await http.read(
          `query ($ids: [ID!]!) { assets(ids: $ids) { ${assetFields} } }`,
          { ids: ids([assetId]) },
          options
        )
        return entities<MondayAsset>(data.assets)[0] ?? null
      },
      async forItem(itemId: string, options?: MondayRequestOptions): Promise<MondayAsset[]> {
        const data = await http.read(
          `query ($ids: [ID!]) { items(ids: $ids) { id assets { ${assetFields} } } }`,
          { ids: [id(itemId)] },
          options
        )
        return entities<MondayAsset>(
          required(entities<Record<string, unknown>>(data.items)[0], "Item").assets
        )
      },
    },
  }
}
