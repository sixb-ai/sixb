import type { FleetioHttp } from "../http"
import type {
  FleetioServiceReminder,
  FleetioServiceReminderCreateInput,
  FleetioServiceReminderFilter,
  FleetioServiceReminderSort,
  FleetioServiceReminderSummary,
  FleetioServiceReminderUpdateInput,
  FleetioServiceReminderWriteResult,
} from "../types"
import {
  type FleetioReadMethods,
  type FleetioWriteMethods,
  readMethods,
  writeMethods,
} from "./crud"

export type ServiceRemindersResource = FleetioReadMethods<
  FleetioServiceReminderSummary,
  FleetioServiceReminder,
  FleetioServiceReminderFilter,
  FleetioServiceReminderSort
> &
  FleetioWriteMethods<
    FleetioServiceReminderCreateInput,
    FleetioServiceReminderWriteResult,
    FleetioServiceReminderUpdateInput,
    FleetioServiceReminderWriteResult
  >

export function serviceRemindersResource(http: FleetioHttp): ServiceRemindersResource {
  return {
    ...readMethods(http, "service_reminders", "service reminder id"),
    ...writeMethods(http, "service_reminders", "service reminder id"),
  }
}
