import type { CtmHttp } from "../http"
import { toPage } from "../pagination"
import type {
  CtmBlockedNumberListOptions,
  CtmId,
  CtmObject,
  CtmPage,
  CtmReceivingNumber,
  CtmRecord,
  CtmTrackingNumberListOptions,
} from "../types"
import { pathId } from "../validation"
import {
  type CtmAccountPath,
  type CtmListMethods,
  type CtmReadMethods,
  listMethods,
  readMethods,
} from "./shared"

/**
 * `GET /numbers` and `/numbers/{id}` — the numbers CTM gives out to track where calls come from.
 * A call's `tracking_number_id` points here.
 */
export interface TrackingNumbersResource
  extends CtmReadMethods<CtmRecord, CtmTrackingNumberListOptions> {
  /** `GET /numbers/{id}/dial_routes` — where the number sends its calls. */
  dialRoutes(trackingNumberId: CtmId): Promise<CtmObject>
}

export function trackingNumbersResource(
  http: CtmHttp,
  at: CtmAccountPath
): TrackingNumbersResource {
  return {
    ...readMethods<CtmRecord, CtmTrackingNumberListOptions>(
      http,
      at,
      "numbers",
      "numbers",
      "trackingNumberId",
      (options) => ({ number: options?.number, name: options?.name })
    ),

    async dialRoutes(trackingNumberId) {
      return http.get(at(`numbers/${pathId(trackingNumberId, "trackingNumberId")}/dial_routes`))
    },
  }
}

/** `GET /receiving_numbers` and `/receiving_numbers/{id}` — the phones calls ring through to. */
export type ReceivingNumbersResource = CtmReadMethods<CtmReceivingNumber>

export function receivingNumbersResource(
  http: CtmHttp,
  at: CtmAccountPath
): ReceivingNumbersResource {
  return readMethods(http, at, "receiving_numbers", "receiving_numbers", "receivingNumberId")
}

/** `GET /target_numbers` and `/target_numbers/{id}` — numbers a tracking number can route to. */
export type TargetNumbersResource = CtmReadMethods<CtmRecord>

export function targetNumbersResource(http: CtmHttp, at: CtmAccountPath): TargetNumbersResource {
  return readMethods(http, at, "target_numbers", "target_numbers", "targetNumberId")
}

/** `GET /do_not_calls` — numbers the account must not call. */
export type DoNotCallResource = CtmListMethods<CtmRecord>

export function doNotCallResource(http: CtmHttp, at: CtmAccountPath): DoNotCallResource {
  return listMethods(http, () => at("do_not_calls"), "do_not_calls")
}

/** `GET /calls/blocked_numbers` — numbers whose calls CTM rejects. A single list, not paged. */
export interface BlockedNumbersResource {
  list(options?: CtmBlockedNumberListOptions): Promise<CtmPage<CtmRecord>>
}

export function blockedNumbersResource(http: CtmHttp, at: CtmAccountPath): BlockedNumbersResource {
  return {
    async list(options) {
      const body = await http.get(at("calls/blocked_numbers"), {
        agency: options?.agencyWide ? 1 : undefined,
      })

      return toPage<CtmRecord>(body, "blocked_numbers", 1)
    },
  }
}
