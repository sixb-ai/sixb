import type { GoogleHttp } from "../../http"
import { listAllPages } from "../../pagination"
import type {
  MeetGetOptions,
  MeetListArtifactsOptions,
  MeetListSmartNotesResponse,
  MeetSmartNote,
} from "../../types/meet"
import { assertMeetPageSize, meetConferenceRecordName, meetSmartNoteName } from "./paths"

export interface MeetSmartNotesResource {
  get(name: string, options?: MeetGetOptions): Promise<MeetSmartNote>
  list(parent: string, options?: MeetListArtifactsOptions): Promise<MeetListSmartNotesResponse>
  listAll(parent: string, options?: MeetListArtifactsOptions): AsyncIterable<MeetSmartNote>
}

export function meetSmartNotesResource(http: GoogleHttp): MeetSmartNotesResource {
  const resource: MeetSmartNotesResource = {
    get(name, options) {
      return http.json("meet", "GET", meetSmartNoteName(name), { query: options })
    },
    list(parent, options) {
      assertMeetPageSize(options?.pageSize, 100)
      return http.json("meet", "GET", `${meetConferenceRecordName(parent, "parent")}/smartNotes`, {
        query: options,
      })
    },
    listAll(parent, options) {
      return listAllPages(
        (pageToken) => resource.list(parent, { ...options, pageToken }),
        (page) => page.smartNotes,
        options?.pageToken
      )
    },
  }
  return resource
}
