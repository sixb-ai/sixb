import type { CtmHttp } from "../http"
import type { CtmRecord, CtmSmsListOptions, CtmTextOptOutListOptions } from "../types"
import { type CtmAccountPath, type CtmReadMethods, readMethods } from "./shared"

/**
 * `GET /sms` and `/sms/{id}` — the account's text messages. They also appear in the call log as
 * `msg_inbound` and `msg_outbound` activities.
 */
export type SmsResource = CtmReadMethods<CtmRecord, CtmSmsListOptions>

export function smsResource(http: CtmHttp, at: CtmAccountPath): SmsResource {
  return readMethods<CtmRecord, CtmSmsListOptions>(http, at, "sms", "sms", "smsId", (options) => ({
    filter: options?.filter,
    start_time: options?.startTime,
    end_time: options?.endTime,
    direction: options?.direction,
  }))
}

/** `GET /opt_out_texts` and `/opt_out_texts/{id}` — numbers that asked not to be texted. */
export type TextOptOutsResource = CtmReadMethods<CtmRecord, CtmTextOptOutListOptions>

export function textOptOutsResource(http: CtmHttp, at: CtmAccountPath): TextOptOutsResource {
  return readMethods<CtmRecord, CtmTextOptOutListOptions>(
    http,
    at,
    "opt_out_texts",
    "opt_out_texts",
    "optOutId",
    (options) => ({
      filter: options?.filter,
      agency: options?.agencyWide ? 1 : undefined,
    })
  )
}
