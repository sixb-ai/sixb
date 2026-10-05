/** Provider block metadata is preserved, including custom templates and future block types. */
export interface PlaudContentBlock {
  data_id: string
  data_type: string
  data_title?: string
  data_tab_name?: string
  data_content?: string | null
  data_link?: string | null
  data_path?: string
  data_error_code?: number
  [key: string]: unknown
}

export interface PlaudRequestOptions {
  signal?: AbortSignal
}
