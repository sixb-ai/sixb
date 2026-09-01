import type { GoogleHttp } from "../../http"
import { listAllPages } from "../../pagination"
import type {
  MeetGetOptions,
  MeetListArtifactsOptions,
  MeetListRecordingsResponse,
  MeetRecording,
} from "../../types/meet"
import { assertMeetPageSize, meetConferenceRecordName, meetRecordingName } from "./paths"

export interface MeetRecordingsResource {
  get(name: string, options?: MeetGetOptions): Promise<MeetRecording>
  list(parent: string, options?: MeetListArtifactsOptions): Promise<MeetListRecordingsResponse>
  listAll(parent: string, options?: MeetListArtifactsOptions): AsyncIterable<MeetRecording>
}

export function meetRecordingsResource(http: GoogleHttp): MeetRecordingsResource {
  const resource: MeetRecordingsResource = {
    get(name, options) {
      return http.json("meet", "GET", meetRecordingName(name), { query: options })
    },
    list(parent, options) {
      assertMeetPageSize(options?.pageSize, 100)
      return http.json("meet", "GET", `${meetConferenceRecordName(parent, "parent")}/recordings`, {
        query: options,
      })
    },
    listAll(parent, options) {
      return listAllPages(
        (pageToken) => resource.list(parent, { ...options, pageToken }),
        (page) => page.recordings,
        options?.pageToken
      )
    },
  }
  return resource
}
