import type { AceIotHttp } from "../http"
import { listAllPages } from "../pagination"
import { pageQuery, timeRangeQuery } from "../query"
import type {
  AceIotPage,
  AceIotPoint,
  AceIotPointInput,
  AceIotPointListAllOptions,
  AceIotPointListOptions,
  AceIotPointWriteOptions,
  AceIotTimeseries,
  AceIotTimeseriesRange,
} from "../types"
import { assertMaxPages, assertPageOptions, pathSegment } from "../validation"

export interface PointsResource {
  /** `GET /points/` — every point visible to the key, across all sites. */
  list(options?: AceIotPointListOptions): Promise<AceIotPage<AceIotPoint>>
  listAll(options?: AceIotPointListAllOptions): AsyncIterable<AceIotPoint>
  /** `GET /points/{point_name}` */
  get(pointName: string): Promise<AceIotPoint>
  /** `POST /points/` — creates or updates a batch. ACE documents no response body. */
  create(points: readonly AceIotPointInput[], options?: AceIotPointWriteOptions): Promise<void>
  /** `PUT /points/{point_name}` — ACE documents no response body. */
  update(
    pointName: string,
    input: AceIotPointInput,
    options?: AceIotPointWriteOptions
  ): Promise<void>
  /** `GET /points/{point_name}/timeseries` */
  getTimeseries(pointName: string, range: AceIotTimeseriesRange): Promise<AceIotTimeseries>
  /**
   * `POST /points/get_timeseries` — readings for many named points at once. A read despite the
   * method, so it is safe to retry and is marked as such.
   */
  getTimeseriesForPoints(
    pointNames: readonly string[],
    range: AceIotTimeseriesRange
  ): Promise<AceIotTimeseries>
}

export function createPointsResource(http: AceIotHttp): PointsResource {
  const resource: PointsResource = {
    list(options) {
      assertPageOptions(options)
      return http.get("points/", pageQuery(options))
    },
    listAll(options) {
      assertMaxPages(options?.maxPages)
      return listAllPages((pageOptions) => resource.list(pageOptions), options)
    },
    get(pointName) {
      return http.get(`points/${pathSegment(pointName, "pointName")}`)
    },
    create(points, options) {
      return http.post("points/", { points }, tagQuery(options))
    },
    update(pointName, input, options) {
      return http.put(`points/${pathSegment(pointName, "pointName")}`, input, tagQuery(options))
    },
    getTimeseries(pointName, range) {
      return http.get(
        `points/${pathSegment(pointName, "pointName")}/timeseries`,
        timeRangeQuery(range)
      )
    },
    getTimeseriesForPoints(pointNames, range) {
      return http.post(
        "points/get_timeseries",
        { points: pointNames.map((name) => ({ name })) },
        timeRangeQuery(range),
        { idempotent: true }
      )
    },
  }

  return resource
}

function tagQuery(options: AceIotPointWriteOptions | undefined) {
  return {
    overwrite_m_tags: options?.overwriteMarkerTags,
    overwrite_kv_tags: options?.overwriteKvTags,
  }
}
