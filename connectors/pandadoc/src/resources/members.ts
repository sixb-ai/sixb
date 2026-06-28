import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import type {
  PandaDocMember,
  PandaDocMemberToken,
  PandaDocMemberTokenInput,
  PandaDocResultsResponse,
} from "../types"

export interface MembersResource {
  /** `GET /public/v1/members` */
  list(): Promise<PandaDocResultsResponse<PandaDocMember>>
  listAll(): AsyncIterable<PandaDocMember>
  /** `GET /public/v1/members/current` */
  current(): Promise<PandaDocMember>
  /** `GET /public/v1/members/{id}` */
  get(id: string): Promise<PandaDocMember>
  /** `POST /public/v1/members/{member_id}/token` */
  createToken(memberId: string, input?: PandaDocMemberTokenInput): Promise<PandaDocMemberToken>
}

export function membersResource(http: PandaDocHttp): MembersResource {
  const resource: MembersResource = {
    list() {
      return http.get("public/v1/members")
    },
    async *listAll() {
      const response = await resource.list()
      yield* response.results
    },
    current() {
      return http.get("public/v1/members/current")
    },
    get(id) {
      return http.get(`public/v1/members/${pathPart(id, "member id")}`)
    },
    createToken(memberId, input = {}) {
      return http.post(`public/v1/members/${pathPart(memberId, "member id")}/token`, input)
    },
  }

  return resource
}
