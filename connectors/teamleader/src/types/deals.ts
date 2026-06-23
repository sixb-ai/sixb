import type {
  TeamleaderCurrencyExchangeRate,
  TeamleaderMoney,
  TeamleaderPage,
  TeamleaderSort,
  TeamleaderTypeAndId,
} from "./common"
import type { TeamleaderCustomField } from "./custom-fields"

export type TeamleaderDealStatus = "new" | "open" | "won" | "lost"

export interface TeamleaderDealsListRequest {
  readonly filter?: {
    readonly ids?: readonly string[]
    readonly term?: string
    readonly customer?: TeamleaderTypeAndId<"contact" | "company">
    readonly phase_id?: string
    readonly estimated_closing_date?: string | null
    readonly estimated_closing_date_from?: string
    readonly estimated_closing_date_until?: string
    readonly responsible_user_id?: string | readonly string[]
    readonly updated_since?: string
    readonly created_before?: string
    readonly status?: readonly ("open" | "won" | "lost")[]
    readonly pipeline_ids?: readonly string[]
  }
  readonly page?: TeamleaderPage
  readonly sort?: readonly TeamleaderSort<"created_at" | "weighted_value">[]
  /** Comma-separated list of optional includes. Documented value: `custom_fields`. */
  readonly includes?: string
}

export interface TeamleaderLead {
  readonly customer?: TeamleaderTypeAndId<"contact" | "company">
  readonly contact_person?: TeamleaderTypeAndId
}

export interface TeamleaderDealListItem {
  readonly id: string
  readonly title?: string
  readonly summary?: string | null
  readonly reference?: string
  readonly status?: TeamleaderDealStatus
  readonly lead?: TeamleaderLead
  readonly department?: TeamleaderTypeAndId<"department">
  readonly estimated_value?: TeamleaderMoney
  readonly estimated_closing_date?: string
  readonly estimated_probability?: number
  readonly weighted_value?: TeamleaderMoney
  readonly purchase_order_number?: string | null
  readonly current_phase?: TeamleaderTypeAndId<"dealPhase">
  readonly responsible_user?: TeamleaderTypeAndId<"user">
  readonly closed_at?: string
  readonly source?: TeamleaderTypeAndId<"dealSource">
  readonly lost_reason?: TeamleaderLostReason | null
  readonly created_at?: string
  readonly updated_at?: string
  readonly web_url?: string
  readonly custom_fields?: readonly TeamleaderCustomField[]
  readonly currency_exchange_rate?: TeamleaderCurrencyExchangeRate
  readonly pipeline?: TeamleaderTypeAndId<"dealPipeline">
}

export interface TeamleaderDeal extends TeamleaderDealListItem {
  readonly status?: "open" | "won" | "lost"
  readonly phase_history?: readonly {
    readonly phase?: TeamleaderTypeAndId<"dealPhase">
    readonly started_at?: string
    readonly started_by?: TeamleaderTypeAndId<"user">
  }[]
  readonly quotations?: readonly TeamleaderTypeAndId<"quotation">[]
}

export interface TeamleaderLostReason {
  readonly reason?: TeamleaderTypeAndId<"lostReason"> | null
  readonly remark?: string | null
}
