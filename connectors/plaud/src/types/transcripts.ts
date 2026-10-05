import type { PlaudContentBlock } from "./common"

export interface PlaudTranscriptSegment {
  start_time: number
  end_time: number
  content: string
  speaker?: string | null
  original_speaker?: string | null
  [key: string]: unknown
}

export interface PlaudTranscript {
  block: PlaudContentBlock
  /** Full, untruncated content, even when the provider changes its JSON shape. */
  content: string
  /** Parsed timestamped segments, or null for non-segment content. */
  segments: PlaudTranscriptSegment[] | null
}
