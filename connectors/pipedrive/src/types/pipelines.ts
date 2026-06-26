import type { PipedriveCursorOptions, PipedriveJsonObject, QueryParams } from "./common"

export interface PipedrivePipeline extends PipedriveJsonObject {
  readonly id: number
  readonly name?: string
  readonly order_nr?: number
  readonly active?: boolean
  readonly add_time?: string
  readonly update_time?: string
}

export interface PipedriveStage extends PipedriveJsonObject {
  readonly id: number
  readonly name?: string
  readonly pipeline_id?: number
  readonly order_nr?: number
  readonly active_flag?: boolean
  readonly add_time?: string
  readonly update_time?: string
}

export type PipedrivePipelineListOptions = QueryParams &
  PipedriveCursorOptions & {
    readonly ids?: readonly number[] | string
    readonly updated_since?: string
    readonly updated_until?: string
  }

export type PipedriveStageListOptions = QueryParams &
  PipedriveCursorOptions & {
    readonly pipeline_id?: number
    readonly ids?: readonly number[] | string
    readonly updated_since?: string
    readonly updated_until?: string
  }
