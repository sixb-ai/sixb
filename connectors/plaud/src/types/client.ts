import type { OAuthConnectorAdapter } from "@sixb/core"
import type { PlaudContentBlock, PlaudRequestOptions } from "./common"
import type {
  PlaudIterateOptions,
  PlaudListOptions,
  PlaudRecording,
  PlaudRecordingDetails,
  PlaudRecordingPage,
} from "./recordings"
import type { PlaudTranscript } from "./transcripts"
import type { PlaudUser } from "./users"

export interface PlaudClient {
  users: { current(options?: PlaudRequestOptions): Promise<PlaudUser> }
  recordings: {
    list(options?: PlaudListOptions): Promise<PlaudRecordingPage>
    iterate(options?: PlaudIterateOptions): AsyncIterable<PlaudRecording>
    get(id: string, options?: PlaudRequestOptions): Promise<PlaudRecordingDetails>
    /** Resolves every source and note block, including linked content. */
    export(id: string, options?: PlaudRequestOptions): Promise<PlaudRecordingDetails>
    /** Returns a response whose body can be streamed to disk. No buffering of the audio. */
    downloadAudio(id: string, options?: PlaudRequestOptions): Promise<Response>
  }
  transcripts: {
    get(
      id: string,
      options?: PlaudRequestOptions & { block?: string }
    ): Promise<PlaudTranscript | null>
    list(id: string, options?: PlaudRequestOptions): Promise<PlaudContentBlock[]>
  }
  notes: { list(id: string, options?: PlaudRequestOptions): Promise<PlaudContentBlock[]> }
}

export type PlaudConnector = OAuthConnectorAdapter<"plaud", PlaudClient>
