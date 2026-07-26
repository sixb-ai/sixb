/**
 * Provider-agnostic speech recognition contract.
 *
 * Deliberately free of React imports. The shape is event-driven so it fits both
 * streaming recognizers (the browser's Web Speech API) and record-then-transcribe
 * backends (MediaRecorder plus a server transcription call), which emit a single
 * final result when the recording stops.
 */

/** Web Speech API error names, plus a catch-all for anything else. */
export type SpeechErrorCode =
  | "aborted"
  | "audio-capture"
  | "language-not-supported"
  | "network"
  | "no-speech"
  | "not-allowed"
  | "service-not-allowed"
  | "unknown"

export type SpeechResult = {
  readonly transcript: string
  /**
   * False for in-progress text the recognizer may still revise. Only final
   * results are accumulated; interim text is replaced on each update.
   */
  readonly isFinal: boolean
}

export type SpeechRecognizerStartOptions = {
  /** BCP 47 tag, e.g. "en-US". */
  readonly lang?: string
  /** Keep recognizing across pauses rather than stopping at the first result. */
  readonly continuous?: boolean
  /** Emit in-progress results, not just final ones. */
  readonly interimResults?: boolean
  readonly maxAlternatives?: number
}

export type SpeechRecognizerHandlers = {
  /** The recognizer is live and capturing audio. */
  onStart?(): void
  onResult?(result: SpeechResult): void
  /** Whether sound or speech is currently reaching the microphone. */
  onAudioActivity?(active: boolean): void
  onError?(code: SpeechErrorCode): void
  /** The session finished, whether by `stop`, `abort`, an error, or the browser. */
  onEnd?(): void
}

export type SpeechSession = {
  /** Finish gracefully, delivering any pending final result. */
  stop(): void
  /** Finish immediately and discard pending results. */
  abort(): void
}

/**
 * Implemented once per speech backend. `start` may throw synchronously if the
 * session cannot be created; callers are expected to treat that as an
 * `"unknown"` error.
 */
export type SpeechRecognizer = {
  readonly id: string
  /** False when the environment cannot recognize speech at all (e.g. Firefox). */
  isSupported(): boolean
  start(options: SpeechRecognizerStartOptions, handlers: SpeechRecognizerHandlers): SpeechSession
}
