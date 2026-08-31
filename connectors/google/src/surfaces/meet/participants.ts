import type { GoogleHttp } from "../../http"
import { listAllPages } from "../../pagination"
import type {
  MeetGetOptions,
  MeetListParticipantsOptions,
  MeetListParticipantsResponse,
  MeetParticipant,
} from "../../types/meet"
import {
  type MeetParticipantSessionsResource,
  meetParticipantSessionsResource,
} from "./participantSessions"
import { assertMeetPageSize, meetConferenceRecordName, meetParticipantName } from "./paths"

export interface MeetParticipantsResource {
  readonly participantSessions: MeetParticipantSessionsResource
  get(name: string, options?: MeetGetOptions): Promise<MeetParticipant>
  list(parent: string, options?: MeetListParticipantsOptions): Promise<MeetListParticipantsResponse>
  listAll(parent: string, options?: MeetListParticipantsOptions): AsyncIterable<MeetParticipant>
}

export function meetParticipantsResource(http: GoogleHttp): MeetParticipantsResource {
  const resource: MeetParticipantsResource = {
    participantSessions: meetParticipantSessionsResource(http),
    get(name, options) {
      return http.json("meet", "GET", meetParticipantName(name), { query: options })
    },
    list(parent, options) {
      assertMeetPageSize(options?.pageSize, 250)
      return http.json(
        "meet",
        "GET",
        `${meetConferenceRecordName(parent, "parent")}/participants`,
        { query: options }
      )
    },
    listAll(parent, options) {
      return listAllPages(
        (pageToken) => resource.list(parent, { ...options, pageToken }),
        (page) => page.participants,
        options?.pageToken
      )
    },
  }
  return resource
}
