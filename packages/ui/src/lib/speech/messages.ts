import type { SpeechErrorCode } from "./types"

/**
 * Appends dictated text to existing text with exactly one separating space.
 *
 * Returns the original text unchanged when the transcript is blank, so a silent
 * result never rewrites what the user already typed.
 */
export function appendDictationText(existingText: string, dictatedText: string): string {
  const transcript = dictatedText.trim()
  if (!transcript) return existingText

  const existing = existingText.trimEnd()
  return existing ? `${existing} ${transcript}` : transcript
}

/**
 * Maps an error code to a message that tells the user what to do about it.
 *
 * Returns null for `"aborted"`, which is what the browser reports when dictation
 * is stopped on purpose — surfacing that as an error would be wrong.
 */
export function speechErrorMessage(code: SpeechErrorCode): string | null {
  switch (code) {
    case "aborted":
      return null
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was denied. Allow microphone access in your browser settings and try again."
    case "audio-capture":
      return "No microphone is available. Connect or enable a microphone and try again."
    case "no-speech":
      return "No speech was detected. Try again when you're ready."
    case "network":
      return "Voice dictation couldn't connect. Check your connection or type instead."
    case "language-not-supported":
      return "Voice dictation isn't available for this language. Type instead."
    default:
      return "Voice dictation couldn't start. Try again or type instead."
  }
}

/** Normalizes an arbitrary error name from the browser onto {@link SpeechErrorCode}. */
export function toSpeechErrorCode(value: unknown): SpeechErrorCode {
  switch (value) {
    case "aborted":
    case "audio-capture":
    case "language-not-supported":
    case "network":
    case "no-speech":
    case "not-allowed":
    case "service-not-allowed":
      return value
    default:
      return "unknown"
  }
}
