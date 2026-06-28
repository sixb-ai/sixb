import type { PandaDocJsonObject, QueryValue } from "./common"

export interface PandaDocNotaryListOptions {
  readonly [key: string]: QueryValue
  readonly status?: readonly string[]
  readonly commission_state?: readonly string[]
  readonly offset?: number
  readonly limit?: number
  readonly order_by?: string
}

export interface PandaDocNotary extends PandaDocJsonObject {
  readonly id?: string
  readonly email?: string
  readonly name?: string
  readonly status?: string
}

export interface PandaDocNotarizationRequestListOptions {
  readonly [key: string]: QueryValue
  readonly status?: readonly string[]
  readonly creator_id?: string
  readonly document_id?: string
  readonly offset?: number
  readonly limit?: number
  readonly order_by?: string
}

export interface PandaDocNotarizationRequest extends PandaDocJsonObject {
  readonly id?: string
  readonly session_request_id?: string
  readonly status?: string
}

export interface PandaDocNotarizationRequestInput extends PandaDocJsonObject {}
