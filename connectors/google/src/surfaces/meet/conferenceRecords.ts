import type { GoogleHttp } from "../../http"
import { listAllPages } from "../../pagination"
import type {
  MeetConferenceRecord,
  MeetGetOptions,
  MeetListConferenceRecordsOptions,
  MeetListConferenceRecordsResponse,
} from "../../types/meet"
import { type MeetParticipantsResource, meetParticipantsResource } from "./participants"
import { assertMeetPageSize, meetConferenceRecordName } from "./paths"
import { type MeetRecordingsResource, meetRecordingsResource } from "./recordings"
import { type MeetSmartNotesResource, meetSmartNotesResource } from "./smartNotes"
import { type MeetTranscriptsResource, meetTranscriptsResource } from "./transcripts"

export interface MeetConferenceRecordsResource {
  readonly participants: MeetParticipantsResource
  readonly recordings: MeetRecordingsResource
  readonly transcripts: MeetTranscriptsResource
  readonly smartNotes: MeetSmartNotesResource
  get(name: string, options?: MeetGetOptions): Promise<MeetConferenceRecord>
  list(options?: MeetListConferenceRecordsOptions): Promise<MeetListConferenceRecordsResponse>
  listAll(options?: MeetListConferenceRecordsOptions): AsyncIterable<MeetConferenceRecord>
}

export function meetConferenceRecordsResource(http: GoogleHttp): MeetConferenceRecordsResource {
  const resource: MeetConferenceRecordsResource = {
    participants: meetParticipantsResource(http),
    recordings: meetRecordingsResource(http),
    transcripts: meetTranscriptsResource(http),
    smartNotes: meetSmartNotesResource(http),
    get(name, options) {
      return http.json("meet", "GET", meetConferenceRecordName(name), { query: options })
    },
    list(options) {
      assertMeetPageSize(options?.pageSize, 100)
      return http.json("meet", "GET", "conferenceRecords", { query: options })
    },
    listAll(options) {
      return listAllPages(
        (pageToken) => resource.list({ ...options, pageToken }),
        (page) => page.conferenceRecords,
        options?.pageToken
      )
    },
  }
  return resource
}
