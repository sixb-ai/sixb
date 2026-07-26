import { useCallback, useEffect, useRef } from "react"
import { appendDictationText } from "../lib/speech"
import type { SpeechRecognitionState, UseSpeechRecognitionOptions } from "./use-speech-recognition"
import { useSpeechRecognition } from "./use-speech-recognition"

export type UseDictationOptions = Omit<UseSpeechRecognitionOptions, "onResult"> & {
  /** Current field text. Dictation is appended to whatever it holds when `start` is called. */
  readonly value: string
  readonly onChange: (value: string) => void
}

/**
 * Dictation wired to a text field: speech is appended to the existing value
 * instead of being handed back as a bare transcript.
 *
 * The text present when `start` is called becomes the base, and each final result
 * is appended to it — so the field should not be edited while dictation runs
 * (`DictationTextarea` makes it read-only for exactly this reason). For anything
 * that is not a field, use {@link useSpeechRecognition} directly.
 */
export function useDictation({
  value,
  onChange,
  ...recognitionOptions
}: UseDictationOptions): SpeechRecognitionState {
  const valueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const baseTextRef = useRef("")
  const dictatedRef = useRef("")

  useEffect(() => {
    valueRef.current = value
  }, [value])

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  const state = useSpeechRecognition({
    ...recognitionOptions,
    onResult: (result) => {
      if (!result.isFinal) return
      dictatedRef.current = appendDictationText(dictatedRef.current, result.transcript)
      onChangeRef.current(appendDictationText(baseTextRef.current, dictatedRef.current))
    },
  })

  const { isActive, start: startRecognition } = state

  const start = useCallback(() => {
    // Re-anchoring mid-session would replay the whole transcript onto the field.
    if (isActive) return
    baseTextRef.current = valueRef.current
    dictatedRef.current = ""
    startRecognition()
  }, [isActive, startRecognition])

  return { ...state, start }
}
