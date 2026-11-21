import { createKernelRuntimeAuthorization } from "../../execution/authorization"
import { ensureExecutionRecord, executionRecordInputFromRuntime } from "../../execution/durable"
import type { ExecutionContext } from "../../execution/types"
import { createAudioRuntime } from "../../models/audio/runtime"
import type { AudioData, TranscriptionOutput } from "../../models/audio/types"
import type { ModelCatalog } from "../../models/catalog"
import { ModelExecutionSession } from "../../models/execution/session"
import type { SixbHostContext } from "../../runtime/types"

/**
 * Transcribes a media's sound for what Sixb derives from it, with the project's transcription
 * model. No one asked but the project, which derives it once for every file that holds the same
 * bytes, so it runs as the kernel operation `artifacts.transcribeMedia`: on the project's model
 * budget, under no one's own limits, recorded as any model call is.
 */
export interface MediaTranscriber {
  /** The project's transcription model, which takes audio up to `maxInputBytes`; null without. */
  readonly model: { readonly maxInputBytes: number } | null
  transcribe(input: {
    /** The media's digest, which names the operation. */
    readonly digest: string
    /** The job that asked, which the operation's execution names as its source. */
    readonly jobId: string
    readonly attempt: number
    readonly audio: AudioData
    readonly signal: AbortSignal
  }): Promise<TranscriptionOutput>
}

export function createMediaTranscriber(
  context: SixbHostContext,
  catalog: ModelCatalog | undefined
): MediaTranscriber {
  const model = catalog?.audio?.transcription?.default.model

  return {
    model: model ? { maxInputBytes: model.definition.maxInputBytes } : null,

    async transcribe(input) {
      const operation = { type: "artifacts.transcribeMedia", digest: input.digest } as const
      const name = input.digest.replace(/^sha256:/, "")
      // One execution per media, which each attempt records its calls under.
      const execution: ExecutionContext = {
        id: `exec_media_${name}`,
        projectId: context.projectId,
        executor: { type: "kernel", operation },
        source: { type: "event", eventId: input.jobId },
        correlationId: `media_${name}`,
      }
      const authorization = createKernelRuntimeAuthorization({ execution, operation })
      await ensureExecutionRecord(context.storage.executions, {
        ...executionRecordInputFromRuntime({ execution, runtimeAuthorization: authorization }),
        requesterGroupIds: [],
      })

      const session = new ModelExecutionSession(
        { ...context, runtimeAuthorization: authorization },
        execution
      )
      session.bind({ attempt: input.attempt, signal: input.signal })
      const audio = createAudioRuntime(
        { projectId: context.projectId, runtimeAuthorization: authorization },
        execution,
        catalog,
        session,
        undefined
      )

      const result = await audio.transcribe({ audio: input.audio, signal: input.signal })
      return result.output
    },
  }
}

const transcribers = new WeakMap<object, MediaTranscriber>()

export function registerMediaTranscriber(host: object, transcriber: MediaTranscriber): void {
  transcribers.set(host, transcriber)
}

/** The transcriber a host registered: a render worker's host is the project's. */
export function findMediaTranscriber(host: object): MediaTranscriber | undefined {
  return transcribers.get(host)
}
