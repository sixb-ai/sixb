import type { PlaudContentBlock } from "./common"

export interface PlaudRecording {
  id: string
  name: string
  created_at: string
  start_at: string
  /** Milliseconds. */
  duration: number
  serial_number: string | null
  [key: string]: unknown
}

export interface PlaudRecordingDetails extends PlaudRecording {
  /** Temporary signed audio URL; null means audio is not available yet. */
  presigned_url: string | null
  source_list: PlaudContentBlock[]
  note_list: PlaudContentBlock[]
}

export interface PlaudRecordingPage {
  type?: string
  data: PlaudRecording[]
  page: number
  page_size: number
  [key: string]: unknown
}

export interface PlaudListOptions {
  page?: number
  /** Plaud rejects values below 10. Defaults to 100. */
  pageSize?: number
  signal?: AbortSignal
}

export interface PlaudIterateOptions extends PlaudListOptions {
  /** Case-insensitive name substring, filtered locally across all pages. */
  query?: string
  /** Inclusive UTC calendar date (YYYY-MM-DD), compared with created_at. */
  dateFrom?: string
  /** Inclusive UTC calendar date (YYYY-MM-DD), compared with created_at. */
  dateTo?: string
}
