import type { PandaDocJsonObject, QueryValue } from "./common"

export interface PandaDocDocxExportTask extends PandaDocJsonObject {
  readonly id?: string
  readonly document_id?: string
  readonly status?: string
}

export interface PandaDocDocumentSummaryOptions {
  readonly [key: string]: QueryValue
  readonly type: "detailed" | "short" | "headline" | "xshort" | (string & {})
}

export interface PandaDocDocumentContentOptions {
  readonly [key: string]: QueryValue
  readonly format: "plaintext" | "markdown" | (string & {})
}

export interface PandaDocDocumentAiMetadataOptions {
  readonly [key: string]: QueryValue
}

export interface PandaDocAiDocumentSearchOptions {
  readonly [key: string]: QueryValue
  readonly q: string
}
