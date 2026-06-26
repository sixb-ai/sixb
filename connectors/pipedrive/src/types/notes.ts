import type { PipedriveJsonObject, PipedriveOffsetOptions, QueryParams } from "./common"

export interface PipedriveNote extends PipedriveJsonObject {
  readonly id: number
  readonly content?: string
  readonly deal_id?: number | null
  readonly lead_id?: string | null
  readonly person_id?: number | null
  readonly org_id?: number | null
  readonly user_id?: number
  readonly add_time?: string
  readonly update_time?: string
}

export interface PipedriveNoteComment extends PipedriveJsonObject {
  readonly id: number
  readonly content?: string
  readonly note_id?: number
  readonly user_id?: number
  readonly add_time?: string
  readonly update_time?: string
}

export type PipedriveNoteListOptions = QueryParams &
  PipedriveOffsetOptions & {
    readonly deal_id?: number
    readonly lead_id?: string
    readonly person_id?: number
    readonly org_id?: number
    readonly user_id?: number
    readonly updated_since?: string
    readonly sort?: string
  }

export type PipedriveNoteCommentsOptions = QueryParams & PipedriveOffsetOptions
