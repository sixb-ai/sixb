import type { MicrosoftHttp } from "./http"
import { type CalendarSurface, calendarSurface } from "./surfaces/calendar"
import { type ContactsSurface, contactsSurface } from "./surfaces/contacts"
import { type DirectorySurface, directorySurface } from "./surfaces/directory"
import { type DrivesSurface, drivesSurface } from "./surfaces/drives"
import { type MailSurface, mailSurface } from "./surfaces/mail"
import { type SitesResource, sitesResource } from "./surfaces/sites"
import {
  type MicrosoftSubscriptionsResource,
  subscriptionsResource,
} from "./surfaces/subscriptions"

export interface MicrosoftClient {
  readonly calendar: CalendarSurface
  readonly contacts: ContactsSurface
  readonly directory: DirectorySurface
  readonly mail: MailSurface
  readonly sites: SitesResource
  readonly drives: DrivesSurface
  readonly subscriptions: MicrosoftSubscriptionsResource
}

export function createMicrosoftClient(
  http: MicrosoftHttp,
  webhookSecret?: string
): MicrosoftClient {
  return {
    calendar: calendarSurface(http),
    contacts: contactsSurface(http, webhookSecret),
    directory: directorySurface(http),
    sites: sitesResource(http),
    drives: drivesSurface(http),
    mail: mailSurface(http, webhookSecret),
    subscriptions: subscriptionsResource(http),
  }
}
