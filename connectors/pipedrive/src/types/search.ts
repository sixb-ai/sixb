import type {
  PipedriveAdditionalData,
  PipedriveCursorOptions,
  PipedriveJsonObject,
  PipedriveResponse,
  QueryParams,
} from "./common"

export interface PipedriveSearchResult extends PipedriveJsonObject {
  readonly id?: number | string
  readonly type?: string
  readonly title?: string
}

export interface PipedriveSearchItems<TItem extends PipedriveJsonObject = PipedriveSearchResult>
  extends PipedriveJsonObject {
  readonly items?: readonly TItem[]
}

export type PipedriveSearchResponse<TItem extends PipedriveJsonObject = PipedriveSearchResult> =
  PipedriveResponse<PipedriveSearchItems<TItem>, PipedriveAdditionalData>

export type PipedriveItemSearchOptions = QueryParams &
  PipedriveCursorOptions & {
    readonly term: string
    readonly item_types?: readonly string[] | string
    readonly fields?: readonly string[] | string
    readonly exact_match?: boolean
  }

export type PipedriveItemSearchByFieldOptions = QueryParams &
  PipedriveCursorOptions & {
    readonly term: string
    readonly entity_type: "deal" | "lead" | "person" | "organization" | "product" | "project"
    readonly field: string
    readonly match?: "exact" | "beginning" | "middle"
  }
