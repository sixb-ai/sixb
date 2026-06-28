import type { PandaDocJsonObject, QueryValue } from "./common"

export interface PandaDocSmsOptOutListOptions {
  readonly [key: string]: QueryValue
  readonly timestamp_from?: string
  readonly timestamp_to?: string
}

export interface PandaDocSmsOptOut extends PandaDocJsonObject {
  readonly phone_number?: string
  readonly status?: string
  readonly opt_out_changed?: string
}
