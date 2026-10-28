import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import {
  createRecordingSpeechRecognizer,
  type SpeechErrorCode,
  type SpeechRecognizerHandlers,
  type SpeechResult,
} from "@sixb/ui/lib/speech"

class FakeTrack {
  stopped = false
  onended: (() => void) | null = null

  stop() {
    this.stopped = true
  }
}

class FakeStream {
  readonly track = new FakeTrack()

  getTracks() {
    return [this.track]
  }

  getAudioTracks() {
    return [this.track]
  }
}

class FakeProcessor {
  onaudioprocess:
    | ((event: { inputBuffer: { sampleRate: number; getChannelData(): Float32Array } }) => void)
    | null = null

  connect() {}

  disconnect() {}

  /** Plays the browser delivering a chunk of microphone samples. */
  hear(samples: Float32Array) {
    this.onaudioprocess?.({ inputBuffer: { sampleRate: 48_000, getChannelData: () => samples } })
  }
}

class FakeAudioContext {
  static last: FakeAudioContext | null = null

  readonly sampleRate = 48_000
  readonly destination = {}
  processor: FakeProcessor | null = null
  closed = false

  constructor() {
    FakeAudioContext.last = this
  }

  createMediaStreamSource() {
    return { connect() {}, disconnect() {} }
  }

  createScriptProcessor() {
    this.processor = new FakeProcessor()
    return this.processor
  }

  async resume() {}

  async close() {
    this.closed = true
  }
}

/** The stream the browser hands out, and the answer to its pending permission prompt. */
type Microphone = {
  readonly stream: FakeStream
  allow(): void
  deny(name: string): void
}

let microphone: Microphone

function installBrowser() {
  const stream = new FakeStream()
  const prompt = Promise.withResolvers<FakeStream>()
  microphone = {
    stream,
    allow: () => prompt.resolve(stream),
    deny: (name) => prompt.reject(Object.assign(new Error(name), { name })),
  }

  Object.assign(globalThis, { AudioContext: FakeAudioContext })
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: () => prompt.promise },
  })
}

function uninstallBrowser() {
  Reflect.deleteProperty(globalThis, "AudioContext")
  Reflect.deleteProperty(navigator, "mediaDevices")
  FakeAudioContext.last = null
}

function processor(): FakeProcessor {
  const node = FakeAudioContext.last?.processor
  if (!node) throw new Error("Recording has not started.")
  return node
}

/** Records every handler call; `started` and `ended` resolve with the session. */
function recordHandlers() {
  const events: string[] = []
  const results: SpeechResult[] = []
  const errors: SpeechErrorCode[] = []
  const activity: boolean[] = []
  const levels: number[] = []
  const started = Promise.withResolvers<void>()
  const ended = Promise.withResolvers<void>()

  const handlers: SpeechRecognizerHandlers = {
    onStart: () => {
      events.push("start")
      started.resolve()
    },
    onAudioActivity: (active) => activity.push(active),
    onAudioLevel: (level) => levels.push(level),
    onAudioEnd: () => events.push("audio-end"),
    onResult: (result) => {
      events.push("result")
      results.push(result)
    },
    onError: (code) => {
      events.push("error")
      errors.push(code)
    },
    onEnd: () => {
      events.push("end")
      ended.resolve()
    },
  }

  return {
    handlers,
    events,
    results,
    errors,
    activity,
    levels,
    started: started.promise,
    ended: ended.promise,
  }
}

/** Starts a session, opens the microphone, and records `chunks` of samples. */
async function recording(
  transcribe: (audio: Blob, options: { readonly signal: AbortSignal }) => Promise<string>,
  chunks: readonly Float32Array[] = [new Float32Array(4096).fill(0.5)]
) {
  const recognizer = createRecordingSpeechRecognizer({ transcribe })
  const session = recordHandlers()
  const handle = recognizer.start({}, session.handlers)
  microphone.allow()
  await session.started
  for (const chunk of chunks) processor().hear(chunk)
  return { ...session, handle }
}

describe("createRecordingSpeechRecognizer", () => {
  beforeEach(installBrowser)

  afterEach(() => {
    uninstallBrowser()
    jest.useRealTimers()
  })

  test("is supported only where the browser can capture the microphone", () => {
    const recognizer = createRecordingSpeechRecognizer({ transcribe: async () => "" })
    expect(recognizer.isSupported()).toBe(true)

    uninstallBrowser()
    expect(recognizer.isSupported()).toBe(false)
  })

  test("transcribes the whole recording once stopped, then releases the microphone", async () => {
    const sent: Blob[] = []
    const session = await recording(async (audio) => {
      sent.push(audio)
      return "Remind Alice about the invoice"
    })

    session.handle.stop()
    await session.ended

    expect(session.events).toEqual(["start", "audio-end", "result", "end"])
    expect(session.results).toEqual([
      { transcript: "Remind Alice about the invoice", isFinal: true },
    ])
    expect(sent.map((audio) => audio.type)).toEqual(["audio/wav"])
    expect(microphone.stream.track.stopped).toBe(true)
    expect(FakeAudioContext.last?.closed).toBe(true)
  })

  // Removal proof: start each chunk at `position` 0; the two chunks give 2732 samples, not 2731.
  test("records 16 kHz mono WAV, whatever rate the microphone runs at", async () => {
    let wav: DataView | undefined
    // Two chunks of 4096 samples, which 48 kHz does not divide evenly into 16 kHz samples.
    const session = await recording(
      async (audio) => {
        wav = new DataView(await audio.arrayBuffer())
        return "ok"
      },
      [new Float32Array(4096).fill(0.5), new Float32Array(4096).fill(-1)]
    )

    session.handle.stop()
    await session.ended

    const text = (offset: number) =>
      String.fromCharCode(...new Uint8Array(wav?.buffer ?? new ArrayBuffer(0), offset, 4))
    expect([text(0), text(8), text(12), text(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"])
    expect(wav?.getUint16(22, true)).toBe(1)
    expect(wav?.getUint32(24, true)).toBe(16_000)
    expect(wav?.getUint16(34, true)).toBe(16)

    const samples = Math.ceil((2 * 4096) / 3)
    expect(wav?.getUint32(40, true)).toBe(samples * 2)
    expect(wav?.byteLength).toBe(44 + samples * 2)
    expect(wav?.getInt16(44, true)).toBe(Math.round(0.5 * 0x7fff))
    expect(wav?.getInt16(wav.byteLength - 2, true)).toBe(-0x8000)
  })

  test("measures what the microphone hears, and falls silent with the session", async () => {
    const session = await recording(
      async () => "ok",
      [new Float32Array(2048).fill(0.5), new Float32Array(2048).fill(0.01), new Float32Array(2048)]
    )

    session.handle.stop()
    await session.ended

    // A raised voice fills the meter, a murmur shows a little, and silence nothing.
    expect(session.levels).toHaveLength(4)
    expect(session.levels[0]).toBe(1)
    expect(session.levels[1]).toBeGreaterThan(0)
    expect(session.levels[1]).toBeLessThan(0.5)
    expect(session.levels.slice(2)).toEqual([0, 0])
    expect(session.activity).toEqual([true, false])
  })

  test("reports a refused microphone without transcribing", async () => {
    let calls = 0
    const recognizer = createRecordingSpeechRecognizer({
      transcribe: async () => {
        calls++
        return "never"
      },
    })
    const session = recordHandlers()

    recognizer.start({}, session.handlers)
    microphone.deny("NotAllowedError")
    await session.ended

    expect(session.events).toEqual(["error", "end"])
    expect(session.errors).toEqual(["not-allowed"])
    expect(calls).toBe(0)
  })

  test("a stop before the microphone opens ends the session without recording", async () => {
    const recognizer = createRecordingSpeechRecognizer({ transcribe: async () => "never" })
    const session = recordHandlers()

    recognizer.start({}, session.handlers).stop()
    microphone.allow()
    await session.ended

    expect(session.events).toEqual(["end"])
    expect(FakeAudioContext.last?.processor).toBeNull()
    expect(microphone.stream.track.stopped).toBe(true)
  })

  test("nothing recorded, a blank transcript or a failed call each say why", async () => {
    for (const [transcribe, chunks, code] of [
      [async () => "never", [], "no-speech"],
      [async () => "  ", undefined, "no-speech"],
      [async () => Promise.reject(new TypeError("Failed to fetch")), undefined, "network"],
      [async () => Promise.reject(new Error("Internal Server Error")), undefined, "unknown"],
    ] as const) {
      installBrowser()
      const session = await recording(transcribe, chunks)

      session.handle.stop()
      await session.ended

      expect(session.errors).toEqual([code])
      expect(session.results).toEqual([])
    }
  })

  // Removal proof: drop `controller.abort()` from abort(); the request's signal stays open.
  test("an abort while transcribing cancels the call and reports nothing", async () => {
    const call = Promise.withResolvers<AbortSignal>()
    const session = await recording((_audio, { signal }) => {
      call.resolve(signal)
      return new Promise<string>(() => {})
    })

    session.handle.stop()
    const signal = await call.promise
    session.handle.abort()
    await session.ended

    expect(signal.aborted).toBe(true)
    expect(session.events).toEqual(["start", "audio-end", "end"])
  })

  test("transcribes what was recorded when the microphone goes away", async () => {
    const session = await recording(async () => "Cut short")

    microphone.stream.track.onended?.()
    await session.ended

    // The hook learns it from onAudioEnd: the recognizer stopped itself.
    expect(session.events).toEqual(["start", "audio-end", "result", "end"])
    expect(session.results).toEqual([{ transcript: "Cut short", isFinal: true }])
  })

  test("stops and transcribes on its own after the longest recording", async () => {
    jest.useFakeTimers()
    const recognizer = createRecordingSpeechRecognizer({
      transcribe: async () => "Long dictation",
      maxDurationMs: 60_000,
    })
    const session = recordHandlers()

    recognizer.start({}, session.handlers)
    microphone.allow()
    await session.started
    processor().hear(new Float32Array(4096).fill(0.5))
    jest.advanceTimersByTime(60_000)
    await session.ended

    expect(session.events).toEqual(["start", "audio-end", "result", "end"])
    expect(session.results).toEqual([{ transcript: "Long dictation", isFinal: true }])
  })
})
