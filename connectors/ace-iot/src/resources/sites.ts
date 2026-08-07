import { AceIotApiError } from "../errors"
import type { AceIotHttp } from "../http"
import { iterateTimeseriesPages, listAllPages } from "../pagination"
import { pageQuery, timeRangeQuery } from "../query"
import type {
  AceIotCreateSiteInput,
  AceIotIterateTimeseriesOptions,
  AceIotPage,
  AceIotPoint,
  AceIotPointListAllOptions,
  AceIotPointListOptions,
  AceIotPointSample,
  AceIotSite,
  AceIotSiteListAllOptions,
  AceIotSiteListOptions,
  AceIotTimeseries,
  AceIotTimeseriesPage,
  AceIotTimeseriesPageOptions,
  AceIotTimeseriesRange,
  AceIotWeather,
  AceIotWeatherResponse,
} from "../types"
import {
  assertMaxPages,
  assertPageOptions,
  assertTimeseriesPageSize,
  pathSegment,
} from "../validation"

export interface SitesResource {
  /** `GET /sites/` */
  list(options?: AceIotSiteListOptions): Promise<AceIotPage<AceIotSite>>
  listAll(options?: AceIotSiteListAllOptions): AsyncIterable<AceIotSite>
  /** `GET /sites/{site_name}` */
  get(siteName: string): Promise<AceIotSite>
  /** `POST /sites/` — ACE documents no response body. */
  create(input: AceIotCreateSiteInput): Promise<void>
  /** `GET /sites/{site_name}/points` — every point known at the site. */
  listPoints(siteName: string, options?: AceIotPointListOptions): Promise<AceIotPage<AceIotPoint>>
  listAllPoints(siteName: string, options?: AceIotPointListAllOptions): AsyncIterable<AceIotPoint>
  /** `GET /sites/{site_name}/configured_points` — only points configured for collection. */
  listConfiguredPoints(
    siteName: string,
    options?: AceIotPointListOptions
  ): Promise<AceIotPage<AceIotPoint>>
  listAllConfiguredPoints(
    siteName: string,
    options?: AceIotPointListAllOptions
  ): AsyncIterable<AceIotPoint>
  /** `GET /sites/{site_name}/timeseries` — the whole window in one response. */
  getTimeseries(siteName: string, range: AceIotTimeseriesRange): Promise<AceIotTimeseries>
  /** `POST /sites/{site_name}/timeseries` — ACE documents no response body. */
  appendTimeseries(siteName: string, samples: AceIotTimeseries): Promise<void>
  /**
   * `GET /sites/{site_name}/timeseries/paginated` — one page, exactly as ACE returns it.
   *
   * The `next_cursor` on the result is ACE's own and does not always advance; prefer
   * `iterateTimeseries` unless you are storing cursors yourself.
   */
  getTimeseriesPage(
    siteName: string,
    options: AceIotTimeseriesPageOptions
  ): Promise<AceIotTimeseriesPage>
  /** Every page of the window, with ACE's cursor repaired on each hop. */
  iterateTimeseriesPages(
    siteName: string,
    options: AceIotIterateTimeseriesOptions
  ): AsyncIterable<AceIotTimeseriesPage>
  /** Every sample in the window, with ACE's cursor repaired on each hop. */
  iterateTimeseries(
    siteName: string,
    options: AceIotIterateTimeseriesOptions
  ): AsyncIterable<AceIotPointSample>
  /**
   * `GET /sites/{site_name}/weather` — last known values for the site's weather points, or `null`
   * when the site has no weather feed (ACE answers 404 with an all-null body).
   */
  getWeather(siteName: string): Promise<AceIotWeather | null>
}

export function createSitesResource(http: AceIotHttp): SitesResource {
  const resource: SitesResource = {
    list(options) {
      assertPageOptions(options)
      return http.get("sites/", {
        ...pageQuery(options),
        collect_enabled: options?.collectEnabled,
        show_archived: options?.showArchived,
      })
    },
    listAll(options) {
      assertMaxPages(options?.maxPages)
      return listAllPages((pageOptions) => resource.list(pageOptions), options)
    },
    get(siteName) {
      return http.get(`sites/${pathSegment(siteName, "siteName")}`)
    },
    create(input) {
      return http.post("sites/", input)
    },
    listPoints(siteName, options) {
      assertPageOptions(options)
      return http.get(`sites/${pathSegment(siteName, "siteName")}/points`, pageQuery(options))
    },
    listAllPoints(siteName, options) {
      assertMaxPages(options?.maxPages)
      return listAllPages((pageOptions) => resource.listPoints(siteName, pageOptions), options)
    },
    listConfiguredPoints(siteName, options) {
      assertPageOptions(options)
      return http.get(
        `sites/${pathSegment(siteName, "siteName")}/configured_points`,
        pageQuery(options)
      )
    },
    listAllConfiguredPoints(siteName, options) {
      assertMaxPages(options?.maxPages)
      return listAllPages(
        (pageOptions) => resource.listConfiguredPoints(siteName, pageOptions),
        options
      )
    },
    getTimeseries(siteName, range) {
      return http.get(
        `sites/${pathSegment(siteName, "siteName")}/timeseries`,
        timeRangeQuery(range)
      )
    },
    appendTimeseries(siteName, samples) {
      return http.post(`sites/${pathSegment(siteName, "siteName")}/timeseries`, samples)
    },
    getTimeseriesPage(siteName, options) {
      if (options.pageSize !== undefined) {
        assertTimeseriesPageSize(options.pageSize)
      }

      return http.get(`sites/${pathSegment(siteName, "siteName")}/timeseries/paginated`, {
        ...timeRangeQuery(options),
        cursor: options.cursor,
        page_size: options.pageSize,
        raw_data: options.rawData,
      })
    },
    iterateTimeseriesPages(siteName, options) {
      assertMaxPages(options.maxPages)
      return iterateTimeseriesPages(
        (pageOptions) => resource.getTimeseriesPage(siteName, pageOptions),
        options
      )
    },
    async *iterateTimeseries(siteName, options) {
      for await (const page of resource.iterateTimeseriesPages(siteName, options)) {
        for (const sample of page.point_samples) {
          yield sample
        }
      }
    },
    async getWeather(siteName) {
      try {
        const response = await http.get<AceIotWeatherResponse>(
          `sites/${pathSegment(siteName, "siteName")}/weather`
        )
        return response.weather
      } catch (error) {
        if (error instanceof AceIotApiError && error.status === 404) {
          return null
        }
        throw error
      }
    },
  }

  return resource
}
