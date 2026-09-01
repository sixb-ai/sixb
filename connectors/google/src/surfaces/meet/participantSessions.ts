import type { GoogleHttp } from "../../http"
import { listAllPages } from "../../pagination"
import type {
  MeetGetOptions,
  MeetListParticipantSessionsOptions,
  MeetListParticipantSessionsResponse,
  MeetParticipantSession,
} from "../../types/meet"
import { assertMeetPageSize, meetParticipantName, meetParticipantSessionName } from "./paths"

export interface MeetParticipantSessionsResource {
  get(name: string, options?: MeetGetOptions): Promise<MeetParticipantSession>
  list(
    parent: string,
    options?: MeetListParticipantSessionsOptions
  ): Promise<MeetListParticipantSessionsResponse>
  listAll(
    parent: string,
    options?: MeetListParticipantSessionsOptions
  ): AsyncIterable<MeetParticipantSession>
}

export function meetParticipantSessionsResource(http: GoogleHttp): MeetParticipantSessionsResource {
  const resource: MeetParticipantSessionsResource = {
    get(name, options) {
      return http.json("meet", "GET", meetParticipantSessionName(name), { query: options })
    },
    list(parent, options) {
      assertMeetPageSize(options?.pageSize, 250)
      return http.json(
        "meet",
        "GET",
        `${meetParticipantName(parent, "parent")}/participantSessions`,
        { query: options }
      )
    },
    listAll(parent, options) {
      return listAllPages(
        (pageToken) => resource.list(parent, { ...options, pageToken }),
        (page) => page.participantSessions,
        options?.pageToken
      )
    },
  }
  return resource
}
