import type { TeamleaderRequester } from "../http"
import { listAll } from "../pagination"
import type {
  TeamleaderClient,
  TeamleaderListResponse,
  TeamleaderQuotation,
  TeamleaderQuotationDownload,
  TeamleaderQuotationListItem,
  TeamleaderSingleResponse,
  TeamleaderTypeAndId,
} from "../types"

export function createQuotationsResource(
  request: TeamleaderRequester
): TeamleaderClient["quotations"] {
  const resource: TeamleaderClient["quotations"] = {
    list(body, requestOptions) {
      return request<TeamleaderListResponse<TeamleaderQuotationListItem>>(
        "/quotations.list",
        body,
        requestOptions
      )
    },
    listAll(body, requestOptions) {
      return listAll(resource.list, body, requestOptions)
    },
    info(body, requestOptions) {
      return request<TeamleaderSingleResponse<TeamleaderQuotation>>(
        "/quotations.info",
        body,
        requestOptions
      )
    },
    create(body, requestOptions) {
      return request<TeamleaderSingleResponse<TeamleaderTypeAndId<"quotation">>>(
        "/quotations.create",
        body,
        requestOptions
      )
    },
    download(body, requestOptions) {
      return request<TeamleaderSingleResponse<TeamleaderQuotationDownload>>(
        "/quotations.download",
        body,
        requestOptions
      )
    },
    send(body, requestOptions) {
      return request<void>("/quotations.send", body, requestOptions)
    },
    update(body, requestOptions) {
      return request<void>("/quotations.update", body, requestOptions)
    },
    accept(body, requestOptions) {
      return request<void>("/quotations.accept", body, requestOptions)
    },
    delete(body, requestOptions) {
      return request<void>("/quotations.delete", body, requestOptions)
    },
  }

  return resource
}
