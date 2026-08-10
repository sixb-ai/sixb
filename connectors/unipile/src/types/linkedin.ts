import type { UnipileLinkedinApi } from "./users"

export interface UnipileLinkedinSearchPeopleInput {
  readonly account_id: string
  /** A Classic, Sales Navigator, or Recruiter people-search URL copied from LinkedIn. */
  readonly url: string
  /** Maximum 100. LinkedIn Classic searches should not exceed 50. */
  readonly limit?: number
  readonly cursor?: string
}

export interface UnipileLinkedinPosition {
  readonly company: string
  readonly company_id?: string | null
  readonly role: string
  readonly description?: string | null
  readonly location?: string | null
  readonly [key: string]: unknown
}

export interface UnipileLinkedinPeopleSearchResult {
  readonly type: "PEOPLE"
  readonly id: string
  readonly name: string | null
  readonly first_name?: string
  readonly last_name?: string
  readonly public_identifier: string | null
  readonly public_profile_url: string | null
  readonly profile_url: string | null
  readonly profile_picture_url: string | null
  readonly member_urn: string | null
  readonly network_distance: string
  readonly location: string | null
  readonly industry: string | null
  readonly headline: string
  readonly pending_invitation?: boolean
  readonly can_send_inmail?: boolean
  readonly premium?: boolean
  readonly open_profile?: boolean
  readonly current_positions?: readonly UnipileLinkedinPosition[]
  readonly [key: string]: unknown
}

export interface UnipileLinkedinSearchConfig {
  readonly params: {
    readonly api?: UnipileLinkedinApi
    readonly category?: string
    readonly [key: string]: unknown
  }
}

export interface UnipileLinkedinSearchPaging {
  readonly start: number
  readonly page_count: number
  readonly total_count: number
}

export interface UnipileLinkedinPeopleSearchResponse {
  readonly object: "LinkedinSearch"
  readonly items: readonly UnipileLinkedinPeopleSearchResult[]
  readonly config: UnipileLinkedinSearchConfig
  readonly paging: UnipileLinkedinSearchPaging
  readonly cursor: string | null
}
