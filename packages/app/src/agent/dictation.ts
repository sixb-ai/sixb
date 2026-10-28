import { type ListModelsResponse, transcribeAudio } from "@sixb/client"
import { createRecordingSpeechRecognizer, type SpeechRecognizer } from "@sixb/ui/lib/speech"

// btoa takes a string of byte characters; spreading the whole recording would overflow the stack.
const BASE64_CHUNK_BYTES = 0x8000

const projectRecognizer = createRecordingSpeechRecognizer({
  id: "sixb-transcription",
  transcribe: transcribeDictation,
})

/**
 * The recognizer behind the chat's microphone, when the project declares a transcription model
 * and the reader may call it; otherwise none, and the chat shows no microphone. Never the
 * browser's own recognition, which sends the audio to Google or Apple.
 */
export function projectDictation(
  catalog: ListModelsResponse | undefined
): SpeechRecognizer | undefined {
  if (!catalog?.capabilities.run || catalog.audio.transcription.length === 0) return undefined
  return projectRecognizer
}

/**
 * Transcribes a recording with the project's default transcription model. The audio travels
 * inline in the request: it reaches the model without ever being stored.
 */
export async function transcribeDictation(
  audio: Blob,
  { signal }: { readonly signal: AbortSignal }
): Promise<string> {
  const { data } = await transcribeAudio({
    body: { audio: { data: await toBase64(audio), mediaType: audio.type } },
    signal,
    throwOnError: true,
  })
  return data.text
}

async function toBase64(audio: Blob): Promise<string> {
  const bytes = new Uint8Array(await audio.arrayBuffer())
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES))
  }

  return btoa(binary)
}
