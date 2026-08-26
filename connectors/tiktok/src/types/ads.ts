import type { TiktokExtensible, TiktokNumberedPage } from "./common"

export type TiktokAdvertiserField =
  | "advertiser_id"
  | "can_use_custom_identity"
  | "ads_only_mode"
  | "owner_bc_id"
  | "status"
  | "role"
  | "rejection_reason"
  | "name"
  | "timezone"
  | "display_timezone"
  | "company"
  | "company_name_editable"
  | "industry"
  | "address"
  | "country"
  | "advertiser_account_type"
  | "currency"
  | "contacter"
  | "email"
  | "cellphone_number"
  | "telephone_number"
  | "language"
  | "license_no"
  | "license_url"
  | "description"
  | "balance"
  | "create_time"

export interface TiktokAdvertiser {
  readonly advertiser_id: string
  readonly can_use_custom_identity?: boolean
  readonly ads_only_mode?: boolean
  readonly owner_bc_id?: string
  readonly status?: string
  readonly role?: string
  readonly rejection_reason?: string
  readonly name?: string
  readonly timezone?: string
  readonly display_timezone?: string
  readonly company?: string
  readonly company_name_editable?: boolean
  readonly industry?: string
  readonly address?: string | null
  readonly country?: string
  readonly advertiser_account_type?: TiktokExtensible<"RESERVATION" | "AUCTION">
  readonly currency?: string
  readonly contacter?: string | null
  readonly email?: string | null
  readonly cellphone_number?: string | null
  readonly telephone_number?: string | null
  readonly language?: string
  readonly license_no?: string
  readonly license_url?: string
  readonly description?: string
  readonly balance?: number
  readonly create_time?: number
  readonly [field: string]: unknown
}

export type TiktokAdsField = string
export type TiktokAdsExcludeFieldType = TiktokExtensible<"NULL_FIELD">

interface TiktokAdsListQueryBase<TFilter> {
  readonly fields?: readonly TiktokAdsField[]
  readonly excludeFieldTypesInResponse?: readonly TiktokAdsExcludeFieldType[]
  readonly filtering?: TFilter
  readonly page?: number
  /** 1-1000. */
  readonly pageSize?: number
}

export interface TiktokCampaignFilter {
  readonly campaign_automation_type?: string
  readonly campaign_ids?: readonly string[]
  readonly campaign_name?: string
  readonly campaign_system_origins?: readonly string[]
  readonly primary_status?: string
  readonly secondary_status?: string
  readonly objective_type?: string
  readonly sales_destination?: string
  readonly buying_types?: readonly string[]
  readonly is_smart_performance_campaign?: boolean
  readonly creative_campaign_type?: string
  readonly split_test_enabled?: boolean
  readonly campaign_product_source?: string
  readonly optimization_goal?: string
  readonly campaign_type?: string
  readonly creation_filter_start_time?: string
  readonly creation_filter_end_time?: string
}

export interface TiktokCampaign {
  readonly advertiser_id: string
  readonly campaign_id: string
  readonly campaign_name?: string
  readonly create_time?: string
  readonly modify_time?: string
  readonly objective_type?: string
  readonly app_promotion_type?: string
  readonly virtual_objective_type?: string
  readonly sales_destination?: string
  readonly is_search_campaign?: boolean
  readonly campaign_automation_type?: string
  readonly is_smart_performance_campaign?: boolean
  readonly campaign_type?: string
  readonly app_id?: string
  readonly is_advanced_dedicated_campaign?: boolean
  readonly disable_skan_campaign?: boolean
  readonly bid_align_type?: string
  readonly campaign_app_profile_page_state?: string
  readonly rf_campaign_type?: string
  readonly campaign_product_source?: string
  readonly catalog_enabled?: boolean
  readonly special_industries?: readonly string[]
  readonly budget_optimize_on?: boolean
  readonly bid_type?: string
  readonly deep_bid_type?: string
  readonly roas_bid?: number
  readonly optimization_goal?: string
  readonly budget_mode?: string
  readonly budget?: number
  readonly rta_id?: string
  readonly rta_bid_enabled?: boolean
  readonly rta_product_selection_enabled?: boolean
  readonly operation_status?: string
  readonly secondary_status?: string
  readonly postback_window_mode?: string
  readonly is_new_structure?: boolean
  readonly objective?: string
  readonly po_number?: string
  readonly [field: string]: unknown
}

export type TiktokCampaignsListQuery = TiktokAdsListQueryBase<TiktokCampaignFilter>

export interface TiktokAdGroupFilter {
  readonly campaign_automation_type?: string
  readonly campaign_ids?: readonly string[]
  readonly campaign_system_origins?: readonly string[]
  readonly adgroup_ids?: readonly string[]
  readonly adgroup_name?: string
  readonly primary_status?: string
  readonly secondary_status?: string
  readonly objective_type?: string
  readonly buying_types?: readonly string[]
  readonly optimization_goal?: string
  readonly promotion_type?: string
  readonly bid_strategy?: string
  readonly creative_material_mode?: string
  readonly billing_events?: readonly string[]
  readonly creation_filter_start_time?: string
  readonly creation_filter_end_time?: string
  readonly split_test_enabled?: boolean
}

export interface TiktokAdGroup {
  readonly advertiser_id: string
  readonly campaign_id: string
  readonly campaign_name?: string
  readonly campaign_system_origin?: string
  readonly adgroup_id: string
  readonly adgroup_name?: string
  readonly create_time?: string
  readonly modify_time?: string
  readonly operation_status?: string
  readonly secondary_status?: string
  readonly budget?: number
  readonly budget_mode?: string
  readonly schedule_type?: string
  readonly schedule_start_time?: string
  readonly schedule_end_time?: string
  readonly optimization_goal?: string
  readonly promotion_type?: string
  readonly billing_event?: string
  readonly bid_price?: number
  readonly conversion_bid_price?: number
  readonly campaign_automation_type?: string
  readonly [field: string]: unknown
}

export type TiktokAdGroupsListQuery = TiktokAdsListQueryBase<TiktokAdGroupFilter>

export interface TiktokAdFilter {
  readonly campaign_automation_type?: string
  readonly ad_ids_v2?: readonly string[]
  readonly campaign_ids?: readonly string[]
  readonly campaign_system_origins?: readonly string[]
  readonly adgroup_ids?: readonly string[]
  readonly ad_ids?: readonly string[]
  readonly primary_status?: string
  readonly secondary_status?: string
  readonly objective_type?: string
  readonly buying_types?: readonly string[]
  readonly optimization_goal?: string
  readonly creative_material_mode?: string
  readonly destination?: string
  readonly creation_filter_start_time?: string
  readonly creation_filter_end_time?: string
  readonly modified_after?: string
}

export interface TiktokAd {
  readonly advertiser_id: string
  readonly campaign_id: string
  readonly campaign_name?: string
  readonly campaign_automation_type?: string
  readonly campaign_system_origin?: string
  readonly adgroup_id: string
  readonly adgroup_name?: string
  readonly smart_plus_ad_id?: string
  readonly ad_id: string
  readonly ad_id_v2?: string
  readonly ad_name?: string
  readonly create_time?: string
  readonly modify_time?: string
  readonly identity_id?: string
  readonly identity_type?: string
  readonly operation_status?: string
  readonly secondary_status?: string
  readonly [field: string]: unknown
}

export type TiktokAdsListQuery = TiktokAdsListQueryBase<TiktokAdFilter>

export type TiktokReportServiceType = "AUCTION" | "RESERVATION"
export type TiktokReportType = TiktokExtensible<
  "BASIC" | "AUDIENCE" | "PLAYABLE_MATERIAL" | "CATALOG" | "BC" | "TT_SHOP"
>
export type TiktokReportFilterType =
  | "IN"
  | "CONTAIN_ANY_OF"
  | "MATCH"
  | "NOT_IN"
  | "GREATER_EQUAL"
  | "GREATER_THAN"
  | "LOWER_EQUAL"
  | "LOWER_THAN"
  | "BETWEEN"

export interface TiktokReportFilter {
  readonly field_name: string
  readonly filter_type: TiktokReportFilterType
  /** TikTok expects the filter value to be JSON-encoded inside this string. */
  readonly filter_value: string
}

export interface TiktokReportQuery {
  readonly serviceType: TiktokReportServiceType
  readonly reportType: TiktokReportType
  readonly dataLevel: string
  readonly dimensions: readonly string[]
  readonly metrics?: readonly string[]
  readonly enableTotalMetrics?: boolean
  readonly startDate?: string
  readonly endDate?: string
  readonly queryLifetime?: boolean
  readonly orderField?: string
  readonly orderType?: "ASC" | "DESC"
  readonly filtering?: readonly TiktokReportFilter[]
  readonly page?: number
  /** 1-1000. */
  readonly pageSize?: number
}

export type TiktokReportMetricValue = string | readonly string[]

export interface TiktokReportRow {
  readonly dimensions: Readonly<Record<string, string>>
  readonly metrics: Readonly<Record<string, TiktokReportMetricValue>>
}

export interface TiktokReportPage extends TiktokNumberedPage<TiktokReportRow> {
  readonly totalMetrics?: Readonly<Record<string, TiktokReportMetricValue>>
}

export interface TiktokAdAccountApi {
  /** TikTok defaults to all ordinary advertiser fields when `fields` is omitted. */
  get(fields?: readonly TiktokAdvertiserField[]): Promise<TiktokAdvertiser>
}

export interface TiktokCampaignsApi {
  list(query?: TiktokCampaignsListQuery): Promise<TiktokNumberedPage<TiktokCampaign>>
  listAll(query?: TiktokCampaignsListQuery): AsyncIterable<TiktokCampaign>
}

export interface TiktokAdGroupsApi {
  list(query?: TiktokAdGroupsListQuery): Promise<TiktokNumberedPage<TiktokAdGroup>>
  listAll(query?: TiktokAdGroupsListQuery): AsyncIterable<TiktokAdGroup>
}

export interface TiktokAdsApi {
  list(query?: TiktokAdsListQuery): Promise<TiktokNumberedPage<TiktokAd>>
  listAll(query?: TiktokAdsListQuery): AsyncIterable<TiktokAd>
}

export interface TiktokReportsApi {
  run(query: TiktokReportQuery): Promise<TiktokReportPage>
  runAll(query: TiktokReportQuery): AsyncIterable<TiktokReportRow>
}
