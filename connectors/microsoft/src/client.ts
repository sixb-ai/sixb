import type { MicrosoftHttp } from "./http"
import { type CalendarSurface, calendarSurface } from "./surfaces/calendar"
import { type DrivesSurface, drivesSurface } from "./surfaces/drives"
import { type MailSurface, mailSurface } from "./surfaces/mail"
import { type SitesResource, sitesResource } from "./surfaces/sites"

export interface MicrosoftClient {
  readonly calendar: CalendarSurface
  readonly mail: MailSurface
  readonly sites: SitesResource
  readonly drives: DrivesSurface
}

export function createMicrosoftClient(http: MicrosoftHttp): MicrosoftClient {
  return {
    calendar: calendarSurface(http),
    sites: sitesResource(http),
    drives: drivesSurface(http),
    mail: mailSurface(http),
  }
}
