import { toAceIotQueryTime } from "./time"
import type { AceIotPageOptions, AceIotTimeseriesRange, QueryParams } from "./types"

/** ACE's `page`/`per_page` pair, shared by every list route. */
export function pageQuery(options?: AceIotPageOptions): QueryParams {
  return {
    page: options?.page,
    per_page: options?.perPage,
  }
}

/** The required `start_time`/`end_time` pair, normalized to UTC ISO. */
export function timeRangeQuery(range: AceIotTimeseriesRange): QueryParams {
  return {
    start_time: toAceIotQueryTime(range.startTime, "startTime"),
    end_time: toAceIotQueryTime(range.endTime, "endTime"),
  }
}
