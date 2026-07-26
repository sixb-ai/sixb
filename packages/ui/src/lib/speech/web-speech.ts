import { toSpeechErrorCode } from "./messages"
import type {
  SpeechRecognizer,
  SpeechRecognizerHandlers,
  SpeechRecognizerStartOptions,
  SpeechSession,
} from "./types"

const WEB_SPEECH_RECOGNIZER_ID = "web-speech"

/**
 * Minimal structural types for the Web Speech API.
 *
 * Declared here rather than taken from `lib.dom.d.ts`, whose speech definitions
 * vary by TypeScript version and are still prefixed in some browsers.
 */
type BrowserSpeechAlternative = { readonly transcript?: string }

type BrowserSpeechResult = {
  readonly isFinal: boolean
  readonly length: number
  readonly [index: number]: BrowserSpeechAlternative | undefined
}

type BrowserSpeechResultList = {
  readonly length: number
  readonly [index: number]: BrowserSpeechResult | undefined
}

type BrowserSpeechResultEvent = {
  readonly resultIndex: number
  readonly results: BrowserSpeechResultList
}

type BrowserSpeechErrorEvent = { readonly error: unknown }

type BrowserSpeechRecognition = {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives: number
  onend: ((event: unknown) => void) | null
  onerror: ((event: BrowserSpeechErrorEvent) => void) | null
  onresult: ((event: BrowserSpeechResultEvent) => void) | null
  onsoundend: ((event: unknown) => void) | null
  onsoundstart: ((event: unknown) => void) | null
  onspeechend: ((event: unknown) => void) | null
  onspeechstart: ((event: unknown) => void) | null
  onstart: ((event: unknown) => void) | null
  abort(): void
  start(): void
  stop(): void
}

export type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition

type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor
  webkitSpeechRecognition?: SpeechRecognitionConstructor
}

export type WebSpeechRecognizerOptions = {
  /** Overrides the constructor looked up on `window`. Primarily for tests. */
  readonly implementation?: SpeechRecognitionConstructor
}

/**
 * Recognizer backed by the browser's built-in Web Speech API — no key, no server.
 *
 * Supported in Chrome, Edge, and Safari (behind the `webkit` prefix) but not
 * Firefox, so always branch on `isSupported()`. Note that Chrome streams audio to
 * Google's servers for recognition; if that is unacceptable for a project, supply
 * a different {@link SpeechRecognizer} instead.
 */
export function createWebSpeechRecognizer(
  options: WebSpeechRecognizerOptions = {}
): SpeechRecognizer {
  function resolveConstructor(): SpeechRecognitionConstructor | null {
    if (options.implementation) return options.implementation
    if (typeof window === "undefined") return null
    const browserWindow = window as SpeechRecognitionWindow
    return browserWindow.SpeechRecognition ?? browserWindow.webkitSpeechRecognition ?? null
  }

  return {
    id: WEB_SPEECH_RECOGNIZER_ID,

    isSupported() {
      return resolveConstructor() !== null
    },

    start(
      startOptions: SpeechRecognizerStartOptions,
      handlers: SpeechRecognizerHandlers
    ): SpeechSession {
      const Recognition = resolveConstructor()
      if (!Recognition) throw new Error("[SixbUI] Speech recognition is unavailable.")

      const recognition = new Recognition()
      recognition.continuous = startOptions.continuous ?? true
      recognition.interimResults = startOptions.interimResults ?? true
      recognition.lang = startOptions.lang ?? "en-US"
      recognition.maxAlternatives = startOptions.maxAlternatives ?? 1

      // The API reports sound and speech separately; either one means the
      // microphone is picking something up.
      let soundDetected = false
      let speechDetected = false
      const reportAudioActivity = () => {
        handlers.onAudioActivity?.(soundDetected || speechDetected)
      }

      recognition.onstart = () => handlers.onStart?.()
      recognition.onsoundstart = () => {
        soundDetected = true
        reportAudioActivity()
      }
      recognition.onsoundend = () => {
        soundDetected = false
        reportAudioActivity()
      }
      recognition.onspeechstart = () => {
        speechDetected = true
        reportAudioActivity()
      }
      recognition.onspeechend = () => {
        speechDetected = false
        reportAudioActivity()
      }

      recognition.onresult = (event) => {
        const finals: string[] = []
        const interims: string[] = []

        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index]
          const transcript = result?.[0]?.transcript
          if (!result || !transcript) continue
          if (result.isFinal) finals.push(transcript)
          else interims.push(transcript)
        }

        // Interim text is reported first so a final result overwrites it rather
        // than the other way round.
        if (interims.length) {
          handlers.onResult?.({ transcript: interims.join(" "), isFinal: false })
        }
        if (finals.length) {
          handlers.onResult?.({ transcript: finals.join(" "), isFinal: true })
        }
      }

      recognition.onerror = (event) => {
        soundDetected = false
        speechDetected = false
        handlers.onError?.(toSpeechErrorCode(event.error))
      }

      recognition.onend = () => {
        soundDetected = false
        speechDetected = false
        handlers.onEnd?.()
      }

      recognition.start()

      return {
        stop() {
          recognition.stop()
        },
        abort() {
          recognition.abort()
        },
      }
    },
  }
}
