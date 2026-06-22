import type {
  TeamleaderCompanyListRequest,
  TeamleaderContactListRequest,
  TeamleaderCustomFieldDefinitionListRequest,
  TeamleaderDealsListRequest,
  TeamleaderListAllOptions,
  TeamleaderListResponse,
  TeamleaderQuotationListRequest,
  TeamleaderRequestOptions,
} from "./types"

const defaultPageSize = 20

type TeamleaderListRequest =
  | TeamleaderDealsListRequest
  | TeamleaderQuotationListRequest
  | TeamleaderContactListRequest
  | TeamleaderCompanyListRequest
  | TeamleaderCustomFieldDefinitionListRequest

type TeamleaderListMethod<TRequest extends TeamleaderListRequest, TItem> = (
  body: TRequest | undefined,
  options?: TeamleaderRequestOptions
) => Promise<TeamleaderListResponse<TItem>>

export async function* listAll<TRequest extends TeamleaderListRequest, TItem>(
  list: TeamleaderListMethod<TRequest, TItem>,
  request: TRequest | undefined,
  options: TeamleaderListAllOptions | undefined
): AsyncIterable<TItem> {
  const requestedPage = request?.page
  const pageSize = options?.pageSize ?? requestedPage?.size ?? defaultPageSize
  let pageNumber = requestedPage?.number ?? 1

  for (;;) {
    const response = await list(
      {
        ...request,
        page: {
          ...requestedPage,
          size: pageSize,
          number: pageNumber,
        },
      } as TRequest,
      options
    )

    for (const item of response.data) {
      yield item
    }

    const matches = response.meta?.matches
    if (
      response.data.length === 0 ||
      response.data.length < pageSize ||
      (typeof matches === "number" && pageNumber * pageSize >= matches)
    ) {
      break
    }

    pageNumber += 1
  }
}
