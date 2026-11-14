import type { CtmActivityDirection } from "./calls"
import type { CtmPageOptions } from "./common"

/** What a report series groups activity by. Others exist; any string is passed through. */
export type CtmReportDimension =
  | "source"
  | "medium"
  | "status"
  | "tracking_number"
  | "receiving_number"
  | "agent"
  | "tag"
  | "report_tag"
  | "landing_host"
  | "landing_path"
  | "referring_host"
  | "referrer_path"
  | "search"
  | "device"
  | "browser"
  | "accounts"
  | "adcampaign"
  | "adgroup"
  | "adcreative"
  | "adkeyword"
  | "adnetwork"
  | "hour"
  | "day"
  | (string & {})

export interface CtmReportSeriesOptions {
  /** First day, inclusive, as `YYYY-MM-DD` in the account's time zone. */
  readonly startDate: string
  /** Last day, inclusive, as `YYYY-MM-DD` in the account's time zone. */
  readonly endDate: string
  readonly by: CtmReportDimension
  readonly direction?: CtmActivityDirection
  /**
   * CTM's other report filters, sent as they are: `talk_time` with `talk_time_operator`,
   * `multi_tags` with `multi_tags_operator`, `multi_tracking_numbers`, … An array repeats its key
   * once per value.
   */
  readonly filters?: Readonly<Record<string, string | number | boolean | readonly string[]>>
}

export interface CtmUsageLogOptions extends CtmPageOptions {
  /** First day, inclusive, as `YYYY-MM-DD` in UTC. */
  readonly startDate: string
  /** Last day, inclusive, as `YYYY-MM-DD` in UTC. */
  readonly endDate: string
  /** Group usage by tracking number or by account. */
  readonly group?: "number" | "account"
  /** Matches account name, number label, source name, or an E.164 number. */
  readonly filter?: string
  /** Every account of the agency instead of this one. Needs an agency key. */
  readonly agencyWide?: boolean
}
