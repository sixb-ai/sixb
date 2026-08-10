import type { UnipileHttp } from "../http"
import type {
  UnipileLinkedinPeopleSearchResponse,
  UnipileLinkedinSearchPeopleInput,
} from "../types"
import { assertLimit, assertLinkedinPeopleSearchUrl, assertNonEmpty } from "../validation"

export interface LinkedinResource {
  /** `POST /linkedin/search` — one page of a people search copied from LinkedIn. */
  searchPeople(
    input: UnipileLinkedinSearchPeopleInput
  ): Promise<UnipileLinkedinPeopleSearchResponse>
}

export function createLinkedinResource(http: UnipileHttp): LinkedinResource {
  return {
    searchPeople(input) {
      assertNonEmpty(input.account_id, "account_id")
      assertLinkedinPeopleSearchUrl(input.url)
      assertLimit(input.limit, 100)
      return http.post(
        "linkedin/search",
        { url: input.url },
        { account_id: input.account_id, cursor: input.cursor, limit: input.limit }
      )
    },
  }
}
