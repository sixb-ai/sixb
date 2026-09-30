import type { FullEnrichHttp } from "../http"
import { searchAllPages } from "../pagination"
import { list, metadata } from "../response"
import type {
  FullEnrichCompaniesResource,
  FullEnrichCompany,
  FullEnrichCompanyLookupRequest,
  FullEnrichCompanySearchRequest,
  FullEnrichCompanySearchResponse,
  FullEnrichLookupMetadata,
  FullEnrichRequestOptions,
  FullEnrichSearchMetadata,
} from "../types"
import { assertObject, assertSearchPage } from "../validation"

export function companiesResource(http: FullEnrichHttp): FullEnrichCompaniesResource {
  async function search(
    request: FullEnrichCompanySearchRequest = {},
    options: FullEnrichRequestOptions = {}
  ): Promise<FullEnrichCompanySearchResponse> {
    assertObject(request, "company search request")
    assertSearchPage(request)
    const body = await http.request({
      operation: "company search",
      method: "POST",
      path: "company/search",
      body: request,
      idempotent: true,
      signal: options.signal,
    })
    return {
      companies: list<FullEnrichCompany>("company search", body, "companies"),
      metadata: metadata<FullEnrichSearchMetadata>("company search", body),
    }
  }

  return {
    search,
    searchAll(request = {}, options = {}) {
      assertObject(request, "company search request")
      assertSearchPage(request)
      return searchAllPages(request, async (page) => {
        const response = await search(page, options)
        return { items: response.companies, metadata: response.metadata }
      })
    },
    async lookup(request: FullEnrichCompanyLookupRequest, options: FullEnrichRequestOptions = {}) {
      assertObject(request, "company lookup request")
      if (
        request.domain === undefined &&
        request.professional_network_url === undefined &&
        request.professional_network_id === undefined
      ) {
        throw new Error(
          "[SixbFullEnrich] company lookup needs a domain, professional_network_url, or professional_network_id."
        )
      }
      const body = await http.request({
        operation: "company lookup",
        method: "POST",
        path: "company/lookup",
        body: request,
        idempotent: true,
        signal: options.signal,
      })
      return {
        companies: list<FullEnrichCompany>("company lookup", body, "companies"),
        metadata: metadata<FullEnrichLookupMetadata>("company lookup", body),
      }
    },
  }
}
