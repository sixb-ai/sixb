"use client"

import type * as React from "react"
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import type { SpeechErrorCode, SpeechRecognizer, SpeechResult, SpeechSession } from "../lib/speech"
import { appendDictationText, createWebSpeechRecognizer, speechErrorMessage } from "../lib/speech"

const DEFAULT_LANG = "en-US"

/**
 * How many times in a row the session may restart without producing speech
 * before giving up, so a microphone left open does not reconnect forever.
 */
const MAX_SILENT_RESTARTS = 3

const SpeechRecognizerContext = createContext<SpeechRecognizer | null>(null)

let sharedWebSpeechRecognizer: SpeechRecognizer | null = null

/** Web Speech recognizer used when an app has not configured one. */
function defaultSpeechRecognizer(): SpeechRecognizer {
  sharedWebSpeechRecognizer ??= createWebSpeechRecognizer()
  return sharedWebSpeechRecognizer
}

/**
 * Configures the speech recognizer for a subtree. Optional — without it,
 * dictation uses the browser's Web Speech API.
 */
export function SpeechRecognitionProvider({
  recognizer,
  children,
}: {
  recognizer?: SpeechRecognizer
  children: React.ReactNode
}) {
  const value = useMemo(() => recognizer ?? defaultSpeechRecognizer(), [recognizer])
  return (
    <SpeechRecognizerContext.Provider value={value}>{children}</SpeechRecognizerContext.Provider>
  )
}

/** Resolves the recognizer to use: an explicit override, the context one, or the default. */
export function useSpeechRecognizer(override?: SpeechRecognizer): SpeechRecognizer {
  const fromContext = useContext(SpeechRecognizerContext)
  return override ?? fromContext ?? defaultSpeechRecognizer()
}

export type SpeechStatus = "idle" | "starting" | "listening" | "stopping"

export type UseSpeechRecognitionOptions = {
  /** Overrides the recognizer from context. */
  readonly recognizer?: SpeechRecognizer
  /** BCP 47 tag. Applies to the next session, not the running one. */
  readonly lang?: string
  readonly continuous?: boolean
  readonly interimResults?: boolean
  readonly maxAlternatives?: number
  /** Stops any running session and blocks new ones. */
  readonly disabled?: boolean
  /**
   * Restart when the browser ends a session on its own. Chrome stops listening
   * after a short silence even with `continuous`, so this is on by default;
   * without it long dictation appears to die mid-sentence.
   */
  readonly autoRestart?: boolean
  /** Called for every result, interim and final, before state updates land. */
  readonly onResult?: (result: SpeechResult) => void
}

export type SpeechRecognitionState = {
  /** Null until support has been probed on the client (it cannot be known during SSR). */
  readonly supported: boolean | null
  readonly status: SpeechStatus
  readonly isActive: boolean
  readonly isReceivingAudio: boolean
  /** Final text accumulated during the current session. Cleared by `start` and `reset`. */
  readonly transcript: string
  /** In-progress text the recognizer may still revise. Empty unless `interimResults`. */
  readonly interimTranscript: string
  /** Human-readable message, or null. Intentional stops never set this. */
  readonly error: string | null
  readonly errorCode: SpeechErrorCode | null
  readonly start: () => void
  readonly stop: () => void
  readonly abort: () => void
  readonly reset: () => void
}

/**
 * Microphone speech recognition over any {@link SpeechRecognizer}.
 *
 * Owns the parts that are easy to get wrong: ignoring events from superseded
 * sessions, accumulating final text across browser-initiated restarts, tracking
 * whether audio is actually arriving, and tearing the microphone down on unmount.
 */
export function useSpeechRecognition(
  options: UseSpeechRecognitionOptions = {}
): SpeechRecognitionState {
  const {
    lang = DEFAULT_LANG,
    continuous = true,
    interimResults = true,
    maxAlternatives = 1,
    disabled = false,
    autoRestart = true,
    onResult,
  } = options

  const recognizer = useSpeechRecognizer(options.recognizer)
  const [supported, setSupported] = useState<boolean | null>(null)
  const [status, setStatus] = useState<SpeechStatus>("idle")
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<SpeechErrorCode | null>(null)
  const [isReceivingAudio, setIsReceivingAudio] = useState(false)
  const [transcript, setTranscript] = useState("")
  const [interimTranscript, setInterimTranscript] = useState("")

  // Monotonic session id: every event handler checks it, so results from a
  // session that has been stopped or superseded are dropped.
  const sessionRef = useRef(0)
  const handleRef = useRef<SpeechSession | null>(null)
  const stopRequestedRef = useRef(false)
  const lastErrorCodeRef = useRef<SpeechErrorCode | null>(null)
  const silentRestartsRef = useRef(0)
  const beginSessionRef = useRef<() => void>(() => {})

  const onResultRef = useRef(onResult)
  useEffect(() => {
    onResultRef.current = onResult
  }, [onResult])

  // Read inside the session callbacks so changing an option never restarts a
  // running session or invalidates the callbacks below.
  const configRef = useRef({ lang, continuous, interimResults, maxAlternatives, autoRestart })
  useEffect(() => {
    configRef.current = { lang, continuous, interimResults, maxAlternatives, autoRestart }
  }, [lang, continuous, interimResults, maxAlternatives, autoRestart])

  useEffect(() => {
    setSupported(recognizer.isSupported())
  }, [recognizer])

  const beginSession = useCallback(() => {
    const session = sessionRef.current + 1
    sessionRef.current = session
    const config = configRef.current

    setStatus("starting")
    setIsReceivingAudio(false)
    setInterimTranscript("")

    try {
      handleRef.current = recognizer.start(
        {
          lang: config.lang,
          continuous: config.continuous,
          interimResults: config.interimResults,
          maxAlternatives: config.maxAlternatives,
        },
        {
          onStart: () => {
            if (sessionRef.current === session) setStatus("listening")
          },
          onAudioActivity: (active) => {
            if (sessionRef.current === session) setIsReceivingAudio(active)
          },
          onResult: (result) => {
            if (sessionRef.current !== session) return
            if (result.isFinal) {
              silentRestartsRef.current = 0
              setInterimTranscript("")
              setTranscript((current) => appendDictationText(current, result.transcript))
            } else {
              setInterimTranscript(result.transcript)
            }
            onResultRef.current?.(result)
          },
          onError: (code) => {
            if (sessionRef.current !== session) return
            lastErrorCodeRef.current = code
            setIsReceivingAudio(false)
            const message = speechErrorMessage(code)
            if (message) {
              setError(message)
              setErrorCode(code)
            }
          },
          onEnd: () => {
            if (sessionRef.current !== session) return
            handleRef.current = null
            setIsReceivingAudio(false)
            setInterimTranscript("")

            // Only a clean end or a silence timeout is worth retrying; a denied
            // microphone or a network failure would loop forever.
            const lastError = lastErrorCodeRef.current
            const retryable = lastError === null || lastError === "no-speech"
            if (
              configRef.current.autoRestart &&
              !stopRequestedRef.current &&
              retryable &&
              silentRestartsRef.current < MAX_SILENT_RESTARTS
            ) {
              silentRestartsRef.current += 1
              lastErrorCodeRef.current = null
              beginSessionRef.current()
              return
            }

            setStatus("idle")
          },
        }
      )
    } catch {
      if (sessionRef.current !== session) return
      handleRef.current = null
      setIsReceivingAudio(false)
      setStatus("idle")
      setError(speechErrorMessage("unknown"))
      setErrorCode("unknown")
    }
  }, [recognizer])

  useEffect(() => {
    beginSessionRef.current = beginSession
  }, [beginSession])

  const abortSession = useCallback((updateState: boolean) => {
    sessionRef.current += 1
    stopRequestedRef.current = true
    const handle = handleRef.current
    handleRef.current = null
    if (handle) {
      try {
        handle.abort()
      } catch {
        // The session may have already ended on its own.
      }
    }
    if (updateState) {
      setIsReceivingAudio(false)
      setInterimTranscript("")
      setStatus("idle")
    }
  }, [])

  useEffect(() => {
    if (disabled) abortSession(true)
  }, [abortSession, disabled])

  useEffect(() => () => abortSession(false), [abortSession])

  const start = useCallback(() => {
    if (disabled || status !== "idle") return
    if (!recognizer.isSupported()) {
      setSupported(false)
      return
    }

    stopRequestedRef.current = false
    lastErrorCodeRef.current = null
    silentRestartsRef.current = 0
    setError(null)
    setErrorCode(null)
    setTranscript("")
    beginSessionRef.current()
  }, [disabled, recognizer, status])

  const stop = useCallback(() => {
    stopRequestedRef.current = true
    const handle = handleRef.current
    if (!handle) return

    setStatus("stopping")
    setIsReceivingAudio(false)
    try {
      handle.stop()
    } catch {
      handleRef.current = null
      setStatus("idle")
      setError(speechErrorMessage("unknown"))
      setErrorCode("unknown")
    }
  }, [])

  const abort = useCallback(() => abortSession(true), [abortSession])

  const reset = useCallback(() => {
    setTranscript("")
    setInterimTranscript("")
    setError(null)
    setErrorCode(null)
  }, [])

  return {
    supported,
    status,
    isActive: status !== "idle",
    isReceivingAudio,
    transcript,
    interimTranscript,
    error,
    errorCode,
    start,
    stop,
    abort,
    reset,
  }
}
