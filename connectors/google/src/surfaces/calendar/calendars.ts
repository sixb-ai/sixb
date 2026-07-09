import type { GoogleHttp } from "../../http"
import { pathSegment } from "../../http"
import type { Calendar } from "../../types/calendar"

function calendarPath(calendarId: string, suffix = ""): string {
  return `calendars/${pathSegment(calendarId, "calendarId")}${suffix}`
}

export interface CalendarsResource {
  /** `GET /calendars/{calendarId}` — calendar metadata. */
  get(calendarId: string): Promise<Calendar>
  /** `POST /calendars` — create a secondary calendar. */
  insert(calendar: Calendar): Promise<Calendar>
  /** `PUT /calendars/{calendarId}` — full replacement of metadata. */
  update(calendarId: string, calendar: Calendar): Promise<Calendar>
  /** `PATCH /calendars/{calendarId}` — partial update of metadata. */
  patch(calendarId: string, calendar: Partial<Calendar>): Promise<Calendar>
  /** `DELETE /calendars/{calendarId}` — delete a secondary calendar. */
  delete(calendarId: string): Promise<void>
  /** `POST /calendars/{calendarId}/clear` — delete every event on a primary calendar. */
  clear(calendarId: string): Promise<void>
}

export function calendarsResource(http: GoogleHttp): CalendarsResource {
  return {
    get(calendarId) {
      return http.json<Calendar>("calendar", "GET", calendarPath(calendarId))
    },
    insert(calendar) {
      return http.json<Calendar>("calendar", "POST", "calendars", { body: calendar })
    },
    update(calendarId, calendar) {
      return http.json<Calendar>("calendar", "PUT", calendarPath(calendarId), { body: calendar })
    },
    patch(calendarId, calendar) {
      return http.json<Calendar>("calendar", "PATCH", calendarPath(calendarId), { body: calendar })
    },
    delete(calendarId) {
      return http.json<void>("calendar", "DELETE", calendarPath(calendarId))
    },
    clear(calendarId) {
      return http.json<void>("calendar", "POST", calendarPath(calendarId, "/clear"))
    },
  }
}
