import type { GoogleHttp } from "../../http"
import {
  type MeetConferenceRecordsResource,
  meetConferenceRecordsResource,
} from "./conferenceRecords"
import { type MeetSpacesResource, meetSpacesResource } from "./spaces"

export interface MeetSurface {
  readonly spaces: MeetSpacesResource
  readonly conferenceRecords: MeetConferenceRecordsResource
}

export function meetSurface(http: GoogleHttp): MeetSurface {
  return {
    spaces: meetSpacesResource(http),
    conferenceRecords: meetConferenceRecordsResource(http),
  }
}
