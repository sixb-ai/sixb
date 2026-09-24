import type { MondayHttp } from "../http"
import { pages } from "../pagination"
import type {
  MondayBoard,
  MondayBoardListOptions,
  MondayColumn,
  MondayGroup,
  MondayRequestOptions,
  MondayView,
} from "../types"
import { entities, id, ids, integer, objectResult, required } from "../validation"

const boardFields =
  "id name description url board_kind type state access_level hierarchy_type workspace_id items_count"
const columnFields = "id title type description settings revision"
export function boardResources(http: MondayHttp) {
  async function list(
    parameters: MondayBoardListOptions = {},
    options?: MondayRequestOptions
  ): Promise<MondayBoard[]> {
    const variables = {
      limit: integer(parameters.limit ?? 25, "limit", 1, 100),
      page: integer(parameters.page ?? 1, "page", 1),
      workspace_ids: parameters.workspace_ids ? ids(parameters.workspace_ids) : undefined,
      state: parameters.state ?? "active",
    }
    const data = await http.read(
      `query ($limit: Int!, $page: Int!, $workspace_ids: [ID], $state: State!) {
      boards(limit: $limit, page: $page, workspace_ids: $workspace_ids, state: $state) { ${boardFields} }
    }`,
      variables,
      options
    )
    return entities<MondayBoard>(data.boards)
  }
  async function board(idValue: string, selection: string, options?: MondayRequestOptions) {
    const data = await http.read(
      `query ($ids: [ID!]) { boards(ids: $ids) { id ${selection} } }`,
      { ids: [id(idValue)] },
      options
    )
    return required(entities<Record<string, unknown>>(data.boards)[0], "Board")
  }
  return {
    boards: {
      list,
      listAll(
        parameters: MondayBoardListOptions = {},
        options?: MondayRequestOptions
      ): AsyncIterable<MondayBoard> {
        const limit = integer(parameters.limit ?? 25, "limit", 1, 100)
        return pages(
          (page) => list({ ...parameters, limit, page }, options),
          integer(parameters.page ?? 1, "page", 1),
          limit
        )
      },
      async get(boardId: string, options?: MondayRequestOptions): Promise<MondayBoard> {
        return objectResult<MondayBoard>(await board(boardId, boardFields, options))
      },
      async views(boardId: string, options?: MondayRequestOptions): Promise<MondayView[]> {
        return entities<MondayView>((await board(boardId, "views { id name type }", options)).views)
      },
    },
    columns: {
      async list(boardId: string, options?: MondayRequestOptions): Promise<MondayColumn[]> {
        return entities<MondayColumn>(
          (await board(boardId, `columns { ${columnFields} }`, options)).columns
        )
      },
      /** Works for classic subitem boards, which cannot be queried through boards(ids:). */
      async forItem(
        itemId: string,
        options?: MondayRequestOptions
      ): Promise<{ board_id: string; columns: MondayColumn[] }> {
        const data = await http.read(
          `query ($ids: [ID!]) {
          items(ids: $ids) { id board { id columns { ${columnFields} } } }
        }`,
          { ids: [id(itemId)] },
          options
        )
        const item = required(entities<Record<string, unknown>>(data.items)[0], "Item")
        const itemBoard = objectResult<Record<string, unknown>>(item.board)
        return {
          board_id: id(itemBoard.id as string),
          columns: entities<MondayColumn>(itemBoard.columns),
        }
      },
    },
    groups: {
      async list(boardId: string, options?: MondayRequestOptions): Promise<MondayGroup[]> {
        return entities<MondayGroup>(
          (await board(boardId, "groups { id title color }", options)).groups
        )
      },
    },
  }
}
