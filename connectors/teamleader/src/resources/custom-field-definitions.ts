import type { TeamleaderRequester } from "../http"
import { listAll } from "../pagination"
import type {
  TeamleaderClient,
  TeamleaderCustomFieldDefinition,
  TeamleaderListResponse,
  TeamleaderSingleResponse,
} from "../types"

export function createCustomFieldDefinitionsResource(
  request: TeamleaderRequester
): TeamleaderClient["customFieldDefinitions"] {
  const resource: TeamleaderClient["customFieldDefinitions"] = {
    list(body, requestOptions) {
      return request<TeamleaderListResponse<TeamleaderCustomFieldDefinition>>(
        "/customFieldDefinitions.list",
        body,
        requestOptions
      )
    },
    listAll(body, requestOptions) {
      return listAll(resource.list, body, requestOptions)
    },
    info(body, requestOptions) {
      return request<TeamleaderSingleResponse<TeamleaderCustomFieldDefinition>>(
        "/customFieldDefinitions.info",
        body,
        requestOptions
      )
    },
  }

  return resource
}
