import type { GoogleHttp } from "../../http"
import type {
  MeetCreateSpaceRequest,
  MeetEmptyResponse,
  MeetGetOptions,
  MeetPatchSpaceOptions,
  MeetPatchSpaceRequest,
  MeetSpace,
  MeetWriteOptions,
} from "../../types/meet"
import { meetSpaceName } from "./paths"

export interface MeetSpacesResource {
  /** Create a meeting space owned by the authenticated user. */
  create(request?: MeetCreateSpaceRequest, options?: MeetWriteOptions): Promise<MeetSpace>
  /** Get a space by stable name or meeting-code alias. */
  get(name: string, options?: MeetGetOptions): Promise<MeetSpace>
  /** Update space configuration using an optional field mask. */
  patch(request: MeetPatchSpaceRequest, options?: MeetPatchSpaceOptions): Promise<MeetSpace>
  /** End the space's active conference, if one exists. */
  endActiveConference(name: string): Promise<MeetEmptyResponse>
}

export function meetSpacesResource(http: GoogleHttp): MeetSpacesResource {
  return {
    create(request = {}, options) {
      return http.json("meet", "POST", "spaces", {
        query: options,
        body: request,
        retryable: false,
      })
    },
    get(name, options) {
      return http.json("meet", "GET", meetSpaceName(name), { query: options })
    },
    patch(request, options) {
      return http.json("meet", "PATCH", meetSpaceName(request.name, "request.name"), {
        query: options,
        body: request,
        retryable: false,
      })
    },
    endActiveConference(name) {
      return http.json("meet", "POST", `${meetSpaceName(name)}:endActiveConference`, {
        body: {},
        retryable: false,
      })
    },
  }
}
