import type { PandaDocJsonObject, PandaDocPageOptions } from "./common"

export interface PandaDocContactListOptions extends PandaDocPageOptions {
  readonly email?: string
  readonly q?: string
}

export interface PandaDocContact extends PandaDocJsonObject {
  readonly id: string
  readonly email?: string
  readonly first_name?: string
  readonly last_name?: string
  readonly company?: string
}

export interface PandaDocContactInput extends PandaDocJsonObject {
  readonly email: string
  readonly first_name?: string
  readonly last_name?: string
  readonly company?: string
  readonly phone?: string
}
