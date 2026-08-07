import type { AceIotListAllOptions, AceIotPageOptions, AceIotTimestamp } from "./common"

/**
 * BACnet metadata scraped from the device.
 *
 * ACE's own schema documents eleven of these properties and types the object as free-form; the
 * live API returns all of the below. Values are strings apart from the four typed numerically or
 * as booleans, and a property the device did not answer for comes back as the literal string
 * `"property: unknown-property"` rather than null or an absent key.
 *
 * The index signature keeps vendor properties outside this list reachable without a cast.
 */
export interface AceIotBacnetData {
  readonly device_address?: string
  readonly device_id?: number
  readonly device_name?: string
  readonly device_description?: string
  readonly object_type?: string
  readonly object_index?: number
  readonly object_name?: string
  readonly object_description?: string
  readonly object_units?: string
  readonly present_value?: string
  readonly recent_value?: string
  readonly recent_timestamp?: string
  readonly priority_array?: string
  readonly scrape_interval?: number
  readonly scrape_enabled?: boolean
  readonly vendor_id?: string
  readonly vendor_name?: string
  readonly model_name?: string
  readonly serial_number?: string
  readonly location?: string
  readonly firmware_revision?: string
  readonly software_version?: string
  readonly database_revision?: string
  readonly protocol_version?: string
  readonly protocol_revision?: string
  readonly system_status?: string
  readonly segmentation_supported?: string
  readonly address_binding?: string
  readonly max_apdu_length?: string
  readonly apdu_timeout?: string
  readonly apdu_retries?: string
  readonly file_size?: string
  readonly file_hash?: string
  readonly [key: string]: string | number | boolean | null | undefined
}

export interface AceIotPoint {
  readonly id: number
  /** Slash-separated path, e.g. `client/site/10.0.0.1-100/analogInput/1`. */
  readonly name: string
  readonly client: string
  readonly site: string
  /** Arbitrary key/value tags. ACE stores strings only. */
  readonly kv_tags: Readonly<Record<string, string>>
  readonly bacnet_data: AceIotBacnetData
  readonly marker_tags: readonly string[]
  /** Config fragment whose shape depends on `point_type`. */
  readonly collect_config: Readonly<Record<string, unknown>>
  readonly point_type: string | null
  readonly collect_enabled: boolean
  /** Collection interval in seconds. */
  readonly collect_interval: number | null
  readonly updated: AceIotTimestamp
  readonly created: AceIotTimestamp
}

export interface AceIotPointListOptions extends AceIotPageOptions {}
export interface AceIotPointListAllOptions extends AceIotListAllOptions {}

/** The writable fields of a point. `name` identifies it. */
export interface AceIotPointInput {
  readonly name: string
  readonly client?: string
  readonly site?: string
  readonly kv_tags?: Readonly<Record<string, string>>
  readonly bacnet_data?: AceIotBacnetData
  readonly marker_tags?: readonly string[]
  readonly collect_config?: Readonly<Record<string, unknown>>
  readonly point_type?: string
  readonly collect_enabled?: boolean
  readonly collect_interval?: number
}

/**
 * Tag-merge behavior for point writes. ACE merges tags into what a point already has unless told
 * to replace them, so both default to false.
 */
export interface AceIotPointWriteOptions {
  /** Replace the point's marker tags instead of merging (`overwrite_m_tags`). */
  readonly overwriteMarkerTags?: boolean
  /** Replace the point's key/value tags instead of merging (`overwrite_kv_tags`). */
  readonly overwriteKvTags?: boolean
}

/** Request body for `POST /points/` and `POST /points/get_timeseries`. */
export interface AceIotPointList {
  readonly points: readonly AceIotPointInput[]
}
