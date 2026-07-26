export { appendDictationText, speechErrorMessage, toSpeechErrorCode } from "./messages"
export type {
  SpeechErrorCode,
  SpeechRecognizer,
  SpeechRecognizerHandlers,
  SpeechRecognizerStartOptions,
  SpeechResult,
  SpeechSession,
} from "./types"
export {
  createWebSpeechRecognizer,
  type SpeechRecognitionConstructor,
  type WebSpeechRecognizerOptions,
} from "./web-speech"
