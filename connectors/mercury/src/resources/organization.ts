import type { MercuryHttp } from "../http"
import type { MercuryOrganization, MercuryOrganizationResponse } from "../types"

export interface OrganizationResource {
  /** `GET /organization` — returns the organization the API token belongs to. */
  get(): Promise<MercuryOrganization>
}

export function createOrganizationResource(http: MercuryHttp): OrganizationResource {
  return {
    async get() {
      // Mercury nests this one behind an `organization` key; every caller wants the record.
      const response = await http.get<MercuryOrganizationResponse>("organization")
      return response.organization
    },
  }
}
