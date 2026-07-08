import type { GoogleHttp } from "./http"
import { type AclResource, aclResource } from "./surfaces/calendar/acl"
import { type CalendarListResource, calendarListResource } from "./surfaces/calendar/calendarList"
import { type CalendarsResource, calendarsResource } from "./surfaces/calendar/calendars"
import { type ChannelsResource, channelsResource } from "./surfaces/calendar/channels"
import { type ColorsResource, colorsResource } from "./surfaces/calendar/colors"
import { type EventsResource, eventsResource } from "./surfaces/calendar/events"
import { type FreebusyResource, freebusyResource } from "./surfaces/calendar/freebusy"
import { type SettingsResource, settingsResource } from "./surfaces/calendar/settings"
import { type DriveChangesResource, driveChangesResource } from "./surfaces/drive/changes"
import { type DriveFilesResource, driveFilesResource } from "./surfaces/drive/files"

export interface DriveSurface {
  readonly files: DriveFilesResource
  readonly changes: DriveChangesResource
}

export interface CalendarSurface {
  readonly events: EventsResource
  readonly calendars: CalendarsResource
  readonly calendarList: CalendarListResource
  readonly acl: AclResource
  readonly settings: SettingsResource
  readonly colors: ColorsResource
  readonly freebusy: FreebusyResource
  readonly channels: ChannelsResource
}

export interface GoogleClient {
  readonly drive: DriveSurface
  readonly calendar: CalendarSurface
}

export function createGoogleClient(http: GoogleHttp): GoogleClient {
  return {
    drive: {
      files: driveFilesResource(http),
      changes: driveChangesResource(http),
    },
    calendar: {
      events: eventsResource(http),
      calendars: calendarsResource(http),
      calendarList: calendarListResource(http),
      acl: aclResource(http),
      settings: settingsResource(http),
      colors: colorsResource(http),
      freebusy: freebusyResource(http),
      channels: channelsResource(http),
    },
  }
}
