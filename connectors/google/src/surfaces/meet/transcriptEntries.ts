import type { GoogleHttp } from "../../http"
import { listAllPages } from "../../pagination"
import type {
  MeetGetOptions,
  MeetListArtifactsOptions,
  MeetListTranscriptEntriesResponse,
  MeetTranscriptEntry,
} from "../../types/meet"
import { assertMeetPageSize, meetTranscriptEntryName, meetTranscriptName } from "./paths"

export interface MeetTranscriptEntriesResource {
  get(name: string, options?: MeetGetOptions): Promise<MeetTranscriptEntry>
  list(
    parent: string,
    options?: MeetListArtifactsOptions
  ): Promise<MeetListTranscriptEntriesResponse>
  listAll(parent: string, options?: MeetListArtifactsOptions): AsyncIterable<MeetTranscriptEntry>
}

export function meetTranscriptEntriesResource(http: GoogleHttp): MeetTranscriptEntriesResource {
  const resource: MeetTranscriptEntriesResource = {
    get(name, options) {
      return http.json("meet", "GET", meetTranscriptEntryName(name), { query: options })
    },
    list(parent, options) {
      assertMeetPageSize(options?.pageSize, 100)
      return http.json("meet", "GET", `${meetTranscriptName(parent, "parent")}/entries`, {
        query: options,
      })
    },
    listAll(parent, options) {
      return listAllPages(
        (pageToken) => resource.list(parent, { ...options, pageToken }),
        (page) => page.transcriptEntries,
        options?.pageToken
      )
    },
  }
  return resource
}
