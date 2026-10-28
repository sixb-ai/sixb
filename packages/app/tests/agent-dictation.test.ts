import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { client, type ListModelsResponse } from "@sixb/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Composer, type ComposerProps } from "../src/agent/components/composer"
import { projectDictation, transcribeDictation } from "../src/agent/dictation"

const originalConfig = client.getConfig()
client.setConfig({ baseUrl: "https://api.sixb.test" })

afterEach(() => {
  client.setConfig({ fetch: originalConfig.fetch })
})

afterAll(() => {
  client.setConfig({ baseUrl: originalConfig.baseUrl })
})

const transcriber = {
  provider: "gateway",
  modelId: "microsoft/mai-transcribe-2",
  isDefault: true,
  name: "MAI Transcribe 2",
  maxInputBytes: 26_214_400,
} as const satisfies ListModelsResponse["audio"]["transcription"][number]

function catalog(options: { run: boolean; transcribers: number }): ListModelsResponse {
  return {
    language: [],
    image: [],
    audio: { speech: [], transcription: Array(options.transcribers).fill(transcriber) },
    capabilities: { run: options.run },
  }
}

describe("projectDictation", () => {
  test("is offered only with a transcription model the reader may call", () => {
    expect(projectDictation(undefined)).toBeUndefined()
    expect(projectDictation(catalog({ run: false, transcribers: 1 }))).toBeUndefined()
    expect(projectDictation(catalog({ run: true, transcribers: 0 }))).toBeUndefined()
    expect(projectDictation(catalog({ run: true, transcribers: 1 }))?.id).toBe("sixb-transcription")
  })
})

describe("transcribeDictation", () => {
  // Removal proof: encode only the first chunk in toBase64; the decoded recording is cut short.
  test("sends the recording inline, so the project never stores it", async () => {
    const requests: { url: string; body: unknown }[] = []
    client.setConfig({
      fetch: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init)
          requests.push({ url: request.url, body: await request.json() })
          return Response.json({ text: "Remind Alice about the invoice" })
        },
        { preconnect: fetch.preconnect }
      ),
    })
    // Just past one base64 chunk, so the chunks are joined in order.
    const recording = Uint8Array.from({ length: 0x8000 + 3 }, (_, index) => index % 251)

    const text = await transcribeDictation(new Blob([recording], { type: "audio/webm" }), {
      signal: new AbortController().signal,
    })

    expect(text).toBe("Remind Alice about the invoice")
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("https://api.sixb.test/api/models/audio/transcriptions")
    const { audio } = requests[0]?.body as { audio: { data: string; mediaType: string } }
    expect(audio.mediaType).toBe("audio/webm")
    expect(new Uint8Array(Buffer.from(audio.data, "base64"))).toEqual(recording)
  })
})

describe("Composer dictation", () => {
  test("shows a microphone only when given a recognizer", () => {
    const recognizer = projectDictation(catalog({ run: true, transcribers: 1 }))

    expect(renderComposer({ dictation: recognizer })).toContain('aria-label="Start dictation"')
    expect(renderComposer()).not.toContain('aria-label="Start dictation"')
  })
})

function renderComposer(props: Partial<ComposerProps> = {}): string {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(Composer, { onSend: () => undefined, ...props })
    )
  )
}
