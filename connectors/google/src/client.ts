import type { GoogleHttp } from "./http"
import { type AnalyticsAdminSurface, analyticsAdminSurface } from "./surfaces/analytics/admin"
import { type AnalyticsDataSurface, analyticsDataSurface } from "./surfaces/analytics/data"
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
import { type GmailDraftsResource, gmailDraftsResource } from "./surfaces/gmail/drafts"
import { type GmailHistoryResource, gmailHistoryResource } from "./surfaces/gmail/history"
import { type GmailLabelsResource, gmailLabelsResource } from "./surfaces/gmail/labels"
import { type GmailMessagesResource, gmailMessagesResource } from "./surfaces/gmail/messages"
import { type GmailSettingsResource, gmailSettingsResource } from "./surfaces/gmail/settings"
import { type GmailThreadsResource, gmailThreadsResource } from "./surfaces/gmail/threads"
import { type GmailUsersResource, gmailUsersResource } from "./surfaces/gmail/users"

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

export interface GmailSurface {
  readonly users: GmailUsersResource
  readonly messages: GmailMessagesResource
  readonly drafts: GmailDraftsResource
  readonly history: GmailHistoryResource
  readonly labels: GmailLabelsResource
  readonly threads: GmailThreadsResource
  readonly settings: GmailSettingsResource
}

export interface AnalyticsSurface {
  readonly admin: AnalyticsAdminSurface
  readonly data: AnalyticsDataSurface
}

export interface GoogleClient {
  readonly drive: DriveSurface
  readonly calendar: CalendarSurface
  readonly gmail: GmailSurface
  readonly analytics: AnalyticsSurface
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
    gmail: {
      users: gmailUsersResource(http),
      messages: gmailMessagesResource(http),
      drafts: gmailDraftsResource(http),
      history: gmailHistoryResource(http),
      labels: gmailLabelsResource(http),
      threads: gmailThreadsResource(http),
      settings: gmailSettingsResource(http),
    },
    analytics: {
      admin: analyticsAdminSurface(http),
      data: analyticsDataSurface(http),
    },
  }
}
