import type { CtmHttp } from "../http"
import type {
  CtmGeoRouterListOptions,
  CtmId,
  CtmPage,
  CtmPageOptions,
  CtmQueue,
  CtmQueueListOptions,
  CtmRecord,
  CtmSourceListOptions,
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
 * `GET /sources` and `/sources/{id}` — the marketing channels CTM attributes calls to, such as
 * Google Ads or Direct. A call's `source_id` points here.
 */
export type SourcesResource = CtmReadMethods<CtmRecord, CtmSourceListOptions>

export function sourcesResource(http: CtmHttp, at: CtmAccountPath): SourcesResource {
  return readMethods<CtmRecord, CtmSourceListOptions>(
    http,
    at,
    "sources",
    "sources",
    "sourceId",
    (options) => ({ name: options?.name })
  )
}

/**
 * `GET /queues` — the call queues. A call path step with `route_type: "CallQueue"` names one by
 * `route_id`.
 */
export type QueuesResource = CtmListMethods<CtmQueue, CtmQueueListOptions>

export function queuesResource(http: CtmHttp, at: CtmAccountPath): QueuesResource {
  return listMethods<CtmQueue, CtmQueueListOptions>(
    http,
    () => at("queues.json"),
    "queues",
    (options) => ({ name: options?.name })
  )
}

/** `GET /schedules` and `/schedules/{id}` — the business hours routing follows. */
export type SchedulesResource = CtmReadMethods<CtmRecord>

export function schedulesResource(http: CtmHttp, at: CtmAccountPath): SchedulesResource {
  return readMethods(http, at, "schedules", "schedules", "scheduleId")
}

/** `GET /voice_menus` and `/voice_menus/{id}` — the phone menus (IVRs) callers press keys in. */
export interface VoiceMenusResource extends CtmReadMethods<CtmRecord> {
  /** `GET /voice_menus/{id}/voice_menu_items` — the menu's options, one per key. */
  listItems(voiceMenuId: CtmId, options?: CtmPageOptions): Promise<CtmPage<CtmRecord>>
  listAllItems(voiceMenuId: CtmId, options?: CtmPageOptions): AsyncIterable<CtmRecord>
  /** `GET /voice_menus/{id}/voice_menu_items/{itemId}` */
  getItem(voiceMenuId: CtmId, itemId: CtmId): Promise<CtmRecord>
}

export function voiceMenusResource(http: CtmHttp, at: CtmAccountPath): VoiceMenusResource {
  const items = (voiceMenuId: CtmId) =>
    at(`voice_menus/${pathId(voiceMenuId, "voiceMenuId")}/voice_menu_items`)

  const itemList = (voiceMenuId: CtmId) =>
    listMethods<CtmRecord>(http, () => items(voiceMenuId), "voice_menu_items")

  return {
    ...readMethods<CtmRecord>(http, at, "voice_menus", "voice_menus", "voiceMenuId"),

    listItems(voiceMenuId, options) {
      return itemList(voiceMenuId).list(options)
    },

    listAllItems(voiceMenuId, options) {
      return itemList(voiceMenuId).listAll(options)
    },

    async getItem(voiceMenuId, itemId) {
      return http.get<CtmRecord>(`${items(voiceMenuId)}/${pathId(itemId, "itemId")}`)
    },
  }
}

/** `GET /conditional_routers` and `/conditional_routers/{id}` — rule-based routing. */
export type SmartRoutersResource = CtmReadMethods<CtmRecord>

export function smartRoutersResource(http: CtmHttp, at: CtmAccountPath): SmartRoutersResource {
  return readMethods(http, at, "conditional_routers", "conditional_routers", "smartRouterId")
}

/** `GET /geo_routes` and `/geo_routes/{id}` — routing by the caller's zip or area code. */
export type GeoRoutersResource = CtmReadMethods<CtmRecord, CtmGeoRouterListOptions>

export function geoRoutersResource(http: CtmHttp, at: CtmAccountPath): GeoRoutersResource {
  return readMethods<CtmRecord, CtmGeoRouterListOptions>(
    http,
    at,
    "geo_routes",
    "geo_routes",
    "geoRouterId",
    (options) => ({ filter: options?.filter })
  )
}

/**
 * `GET /triggers` and `/triggers/{id}` — the automations CTM runs on an activity, such as sending
 * an event to an analytics tool when a call ends.
 */
export type TriggersResource = CtmReadMethods<CtmRecord>

export function triggersResource(http: CtmHttp, at: CtmAccountPath): TriggersResource {
  return readMethods(http, at, "triggers", "triggers", "triggerId")
}
