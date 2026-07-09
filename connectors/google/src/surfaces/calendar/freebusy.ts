import type { GoogleHttp } from "../../http"
import type { FreeBusyRequest, FreeBusyResponse } from "../../types/calendar"

export interface FreebusyResource {
  /** `POST /freeBusy` — free/busy information for a set of calendars. */
  query(request: FreeBusyRequest): Promise<FreeBusyResponse>
}

export function freebusyResource(http: GoogleHttp): FreebusyResource {
  return {
    query(request) {
      return http.json<FreeBusyResponse>("calendar", "POST", "freeBusy", { body: request })
    },
  }
}
