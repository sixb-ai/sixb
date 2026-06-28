import type { PandaDocJsonObject, PandaDocPageOptions, QueryValue } from "./common"

export interface PandaDocLogListOptions extends PandaDocPageOptions {
  readonly [key: string]: QueryValue
  readonly since?: string
  readonly to?: string
  readonly statuses?: readonly string[]
  readonly methods?: readonly string[]
  readonly search?: string
  readonly environment_type?: string
}

export interface PandaDocLogEvent extends PandaDocJsonObject {
  readonly id?: string
  readonly uuid?: string
  readonly status?: number | string
  readonly method?: string
  readonly path?: string
}
