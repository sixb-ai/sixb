import type { PandaDocJsonObject } from "./common"

export interface PandaDocFolder extends PandaDocJsonObject {
  readonly uuid: string
  readonly name: string
  readonly date_created?: string
  readonly parent_uuid?: string | null
  readonly has_folders?: boolean
  readonly has_items?: boolean
}

export interface PandaDocFolderInput extends PandaDocJsonObject {
  readonly name: string
  readonly parent_uuid?: string
}
