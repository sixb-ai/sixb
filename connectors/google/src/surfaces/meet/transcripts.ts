import type { GoogleHttp } from "../../http"
import { listAllPages } from "../../pagination"
import type {
  MeetGetOptions,
  MeetListArtifactsOptions,
  MeetListTranscriptsResponse,
  MeetTranscript,
} from "../../types/meet"
import { assertMeetPageSize, meetConferenceRecordName, meetTranscriptName } from "./paths"
import {
  type MeetTranscriptEntriesResource,
  meetTranscriptEntriesResource,
} from "./transcriptEntries"

export interface MeetTranscriptsResource {
  readonly entries: MeetTranscriptEntriesResource
  get(name: string, options?: MeetGetOptions): Promise<MeetTranscript>
  list(parent: string, options?: MeetListArtifactsOptions): Promise<MeetListTranscriptsResponse>
  listAll(parent: string, options?: MeetListArtifactsOptions): AsyncIterable<MeetTranscript>
}

export function meetTranscriptsResource(http: GoogleHttp): MeetTranscriptsResource {
  const resource: MeetTranscriptsResource = {
    entries: meetTranscriptEntriesResource(http),
    get(name, options) {
      return http.json("meet", "GET", meetTranscriptName(name), { query: options })
    },
    list(parent, options) {
      assertMeetPageSize(options?.pageSize, 100)
      return http.json("meet", "GET", `${meetConferenceRecordName(parent, "parent")}/transcripts`, {
        query: options,
      })
    },
    listAll(parent, options) {
      return listAllPages(
        (pageToken) => resource.list(parent, { ...options, pageToken }),
        (page) => page.transcripts,
        options?.pageToken
      )
    },
  }
  return resource
}
