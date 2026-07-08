import type { GoogleHttp } from "../../http"
import type { Colors } from "../../types/calendar"

export interface ColorsResource {
  /** `GET /colors` — the color definitions for calendars and events. */
  get(): Promise<Colors>
}

export function colorsResource(http: GoogleHttp): ColorsResource {
  return {
    get() {
      return http.json<Colors>("calendar", "GET", "colors")
    },
  }
}
