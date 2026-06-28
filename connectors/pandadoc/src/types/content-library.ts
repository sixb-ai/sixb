import type { PandaDocJsonObject, PandaDocPageOptions } from "./common"

export interface PandaDocContentLibraryItemListOptions extends PandaDocPageOptions {
  readonly q?: string
  readonly id?: string
  readonly deleted?: boolean
  readonly folder_uuid?: string
  readonly tag?: string
}

export interface PandaDocContentLibraryItem extends PandaDocJsonObject {
  readonly id: string
  readonly name?: string
  readonly status?: string
  readonly date_created?: string
  readonly date_modified?: string
  readonly version?: string
}

export interface PandaDocContentLibraryItemInput extends PandaDocJsonObject {
  readonly name: string
}
