import type { FullEnrichHttp } from "../http"
import { searchAllPages } from "../pagination"
import { list, metadata } from "../response"
import type {
  FullEnrichLookupMetadata,
  FullEnrichPeopleResource,
  FullEnrichPeopleSearchRequest,
  FullEnrichPeopleSearchResponse,
  FullEnrichPerson,
  FullEnrichPersonLookupRequest,
  FullEnrichRequestOptions,
  FullEnrichSearchMetadata,
} from "../types"
import { assertObject, assertSearchPage } from "../validation"

export function peopleResource(http: FullEnrichHttp): FullEnrichPeopleResource {
  async function search(
    request: FullEnrichPeopleSearchRequest = {},
    options: FullEnrichRequestOptions = {}
  ): Promise<FullEnrichPeopleSearchResponse> {
    assertObject(request, "people search request")
    assertSearchPage(request)
    const body = await http.request({
      operation: "people search",
      method: "POST",
      path: "people/search",
      body: request,
      idempotent: true,
      signal: options.signal,
    })
    return {
      people: list<FullEnrichPerson>("people search", body, "people"),
      metadata: metadata<FullEnrichSearchMetadata>("people search", body),
    }
  }

  return {
    search,
    searchAll(request = {}, options = {}) {
      assertObject(request, "people search request")
      assertSearchPage(request)
      return searchAllPages(request, async (page) => {
        const response = await search(page, options)
        return { items: response.people, metadata: response.metadata }
      })
    },
    async lookup(request: FullEnrichPersonLookupRequest, options: FullEnrichRequestOptions = {}) {
      assertLookup(request)
      const body = await http.request({
        operation: "people lookup",
        method: "POST",
        path: "people/lookup",
        body: request,
        idempotent: true,
        signal: options.signal,
      })
      return {
        people: list<FullEnrichPerson>("people lookup", body, "people"),
        metadata: metadata<FullEnrichLookupMetadata>("people lookup", body),
      }
    },
  }
}

function assertLookup(request: FullEnrichPersonLookupRequest): void {
  assertObject(request, "people lookup request")
  const byProfile =
    request.person_professional_network_url !== undefined ||
    request.person_professional_network_id !== undefined
  const byCompany =
    request.company_domain !== undefined ||
    request.company_professional_network_url !== undefined ||
    request.company_professional_network_id !== undefined
  if (!byProfile && !(request.person_name !== undefined && byCompany)) {
    throw new Error(
      "[SixbFullEnrich] people lookup needs person_professional_network_url or _id, or person_name with a company domain, LinkedIn URL, or LinkedIn ID."
    )
  }
}
