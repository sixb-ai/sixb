import type { PandaDocJsonObject, PandaDocPageOptions } from "./common"

export interface PandaDocTemplateListOptions extends PandaDocPageOptions {
  readonly q?: string
  readonly folder_uuid?: string
  readonly tag?: string | readonly string[]
  readonly fields?: readonly string[]
  readonly deleted?: boolean
}

export interface PandaDocTemplateSummary extends PandaDocJsonObject {
  readonly id: string
  readonly name?: string
  readonly date_created?: string
  readonly date_modified?: string
  readonly content_date_modified?: string
  readonly version?: string
}

export interface PandaDocTemplateDetails extends PandaDocTemplateSummary {
  readonly roles?: readonly PandaDocJsonObject[]
  readonly fields?: readonly PandaDocJsonObject[] | PandaDocJsonObject
  readonly tokens?: readonly PandaDocJsonObject[] | PandaDocJsonObject
  readonly pricing?: PandaDocJsonObject
  readonly metadata?: PandaDocJsonObject
  readonly tags?: readonly string[]
}

export interface PandaDocTemplateInput extends PandaDocJsonObject {
  readonly name: string
}

export interface PandaDocTemplateCreateOptions {
  readonly editor_ver?: string
}

export interface PandaDocTemplateEditingSessionInput extends PandaDocJsonObject {
  readonly lifetime?: number
}

export interface PandaDocTemplateSettings extends PandaDocJsonObject {}
