import type { AceIotTimeInput, AceIotTimestamp } from "./common"

/**
 * Page sizes the paginated timeseries endpoint accepts. This is a different enum than `per_page`:
 * it allows 3 but not 2, and reaches 500,000.
 */
export const ACE_IOT_PAGE_SIZE_VALUES = [
  3, 10, 50, 100, 500, 1000, 5000, 10000, 50000, 100000, 300000, 500000,
] as const

export type AceIotTimeseriesPageSize = (typeof ACE_IOT_PAGE_SIZE_VALUES)[number]

/**
 * One reading. `value` is always a string on the wire, including numerics such as
 * `"1.6100000143051147"` — it is left alone so the connector never introduces rounding the API did
 * not have. `time` is a naive UTC timestamp; see `parseAceIotTimestamp`.
 */
export interface AceIotPointSample {
  readonly name: string
  readonly value: string
  readonly time: AceIotTimestamp
}

/** The unpaginated timeseries response, and the body accepted when appending samples. */
export interface AceIotTimeseries {
  readonly point_samples: readonly AceIotPointSample[]
}

/**
 * One page of `GET /sites/{site_name}/timeseries/paginated`.
 *
 * `next_cursor` is base64 JSON, and ACE miscomputes it — see `iterateTimeseriesPages`, which
 * repairs it. Reading `next_cursor` directly is only safe when a page ends in a later timestamp
 * bucket than the one its request started in.
 */
export interface AceIotTimeseriesPage {
  readonly point_samples: readonly AceIotPointSample[]
  readonly next_cursor: string | null
  readonly has_more: boolean
}

export interface AceIotTimeseriesRange {
  readonly startTime: AceIotTimeInput
  readonly endTime: AceIotTimeInput
}

export interface AceIotTimeseriesPageOptions extends AceIotTimeseriesRange {
  readonly cursor?: string
  /** Defaults to ACE's own default of 10,000. */
  readonly pageSize?: AceIotTimeseriesPageSize
  /** Return readings as recorded instead of ACE's 5-minute buckets. Defaults to false. */
  readonly rawData?: boolean
}

export interface AceIotIterateTimeseriesOptions extends AceIotTimeseriesPageOptions {
  /** Stop after this many pages. Unbounded by default. */
  readonly maxPages?: number
}

/**
 * A weather reading. Every field is nullable: ACE answers a site with no weather feed with a 404
 * whose body has this shape with all-null members.
 */
export interface AceIotWeatherReading {
  readonly name: string | null
  readonly value: string | null
  readonly time: AceIotTimestamp | null
}

/** Last known values for a site's weather trending points. */
export interface AceIotWeather {
  readonly temp: AceIotWeatherReading
  readonly feels_like: AceIotWeatherReading
  readonly pressure: AceIotWeatherReading
  readonly humidity: AceIotWeatherReading
  readonly dew_point: AceIotWeatherReading
  readonly clouds: AceIotWeatherReading
  readonly wind_speed: AceIotWeatherReading
  readonly wind_deg: AceIotWeatherReading
  readonly wet_bulb: AceIotWeatherReading
}

export interface AceIotWeatherResponse {
  readonly weather: AceIotWeather
}
