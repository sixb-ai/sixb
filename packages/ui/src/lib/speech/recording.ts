import type {
  SpeechErrorCode,
  SpeechRecognizer,
  SpeechRecognizerHandlers,
  SpeechSession,
} from "./types"

const RECORDING_RECOGNIZER_ID = "recording"

/**
 * The rate speech models listen at. Mono 16-bit samples make 32 kB a second: five minutes stay
 * under 10 MB.
 */
const SAMPLE_RATE = 16_000

const DEFAULT_MAX_DURATION_MS = 5 * 60_000

/** Samples per capture callback: about 43 ms at the usual 48 kHz, a smooth level meter. */
const CAPTURE_FRAMES = 2048

/** Root mean square of the waveform, from 0 to 1, above which the microphone hears something. */
const SOUND_LEVEL = 0.02

/** How long sound counts as present after it stops, so the gaps between words do not flicker. */
const SOUND_HOLD_MS = 600

/** The loudness range a level spans, in decibels: a quiet room at 0, a raised voice at 1. */
const LEVEL_FLOOR_DB = -55
const LEVEL_CEILING_DB = -10

export type RecordingSpeechRecognizerOptions = {
  /**
   * Turns a finished recording, a 16 kHz mono WAV file, into text: typically a call to a
   * transcription model. Reject with a `TypeError`, as `fetch` does, when the server cannot be
   * reached; any other rejection is reported as an unknown failure. `signal` aborts with the
   * session.
   */
  readonly transcribe: (audio: Blob, options: { readonly signal: AbortSignal }) => Promise<string>
  readonly id?: string
  /** Stops and transcribes on its own after this long, so a forgotten microphone ends. */
  readonly maxDurationMs?: number
}

/**
 * Record-then-transcribe recognizer: records the microphone and, once stopped, hands the whole
 * recording to `transcribe`, then reports one final result.
 *
 * It records WAV, the format transcription models accept most widely, rather than what
 * `MediaRecorder` produces: WebM in Chrome and MP4 in Safari, which some models refuse. It never
 * reports interim text and never ends on silence: only `stop`, `abort`, an error or
 * `maxDurationMs` (five minutes by default) end a session, and the microphone is released as soon
 * as recording stops.
 */
export function createRecordingSpeechRecognizer(
  options: RecordingSpeechRecognizerOptions
): SpeechRecognizer {
  return {
    id: options.id ?? RECORDING_RECOGNIZER_ID,

    isSupported() {
      return (
        typeof AudioContext !== "undefined" &&
        typeof navigator !== "undefined" &&
        typeof navigator.mediaDevices?.getUserMedia === "function"
      )
    },

    start(_startOptions, handlers) {
      return startRecording(options, handlers)
    },
  }
}

type RecordingState = "opening" | "recording" | "transcribing" | "ended"

function startRecording(
  options: RecordingSpeechRecognizerOptions,
  handlers: SpeechRecognizerHandlers
): SpeechSession {
  // Created during the click that starts the session: Safari only plays audio a gesture started.
  const context = new AudioContext()
  const controller = new AbortController()
  const sound = createSoundMeter(handlers)

  let state: RecordingState = "opening"
  let stopWhenOpen = false
  let stream: MediaStream | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let processor: ScriptProcessorNode | null = null
  let wav: WavEncoder | null = null
  let deadline: ReturnType<typeof setTimeout> | undefined
  let released = false

  const releaseMicrophone = () => {
    if (released) return
    released = true
    clearTimeout(deadline)
    sound.reset()
    processor?.disconnect()
    source?.disconnect()
    for (const track of stream?.getTracks() ?? []) track.stop()
    stream = null
    void context.close().catch(() => undefined)
  }

  const end = () => {
    if (state === "ended") return
    state = "ended"
    releaseMicrophone()
    handlers.onEnd?.()
  }

  const fail = (code: SpeechErrorCode) => {
    if (state === "ended") return
    handlers.onError?.(code)
    end()
  }

  const transcribe = async () => {
    state = "transcribing"
    releaseMicrophone()
    handlers.onAudioEnd?.()

    if (!wav || wav.sampleCount === 0) {
      fail("no-speech")
      return
    }

    try {
      const transcript = await options.transcribe(wav.encode(), { signal: controller.signal })
      if (state !== "transcribing") return

      if (!transcript.trim()) {
        fail("no-speech")
        return
      }

      handlers.onResult?.({ transcript, isFinal: true })
      end()
    } catch (error) {
      fail(error instanceof TypeError ? "network" : "unknown")
    }
  }

  const record = (granted: MediaStream) => {
    if (state !== "opening") {
      for (const track of granted.getTracks()) track.stop()
      return
    }

    stream = granted
    if (stopWhenOpen) {
      end()
      return
    }

    try {
      // ScriptProcessorNode is deprecated, but an AudioWorklet loads its code from a URL, which a
      // strict Content-Security-Policy may refuse; this works in every browser, with no setup.
      source = context.createMediaStreamSource(granted)
      processor = context.createScriptProcessor(CAPTURE_FRAMES, 1, 1)
      processor.onaudioprocess = (event) => {
        if (state !== "recording") return

        // The buffer's own rate: iOS may switch the microphone's once it opens.
        wav ??= createWavEncoder(event.inputBuffer.sampleRate)
        const samples = event.inputBuffer.getChannelData(0)
        wav.append(samples)
        sound.measure(samples)
      }
      source.connect(processor)
      // A processor only runs while connected to the output. It writes nothing there: silence.
      processor.connect(context.destination)
    } catch {
      fail("audio-capture")
      return
    }

    // A microphone unplugged mid-sentence: what was recorded is still transcribed.
    for (const track of granted.getAudioTracks()) track.onended = stop

    void context.resume().catch(() => undefined)
    state = "recording"
    deadline = setTimeout(stop, options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS)
    handlers.onStart?.()
  }

  function stop() {
    if (state === "opening") stopWhenOpen = true
    if (state === "recording") void transcribe()
  }

  navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then(record, (error: unknown) => fail(microphoneErrorCode(error)))

  return {
    stop,
    abort() {
      controller.abort()
      end()
    },
  }
}

function microphoneErrorCode(error: unknown): SpeechErrorCode {
  const name = error instanceof Error ? error.name : undefined
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "not-allowed"
    case "NotFoundError":
    case "NotReadableError":
    case "OverconstrainedError":
      return "audio-capture"
    default:
      return "unknown"
  }
}

type WavEncoder = {
  readonly sampleCount: number
  /** Takes samples at the context's rate, from -1 to 1. */
  append(samples: Float32Array): void
  encode(): Blob
}

/** Resamples to {@link SAMPLE_RATE} as samples arrive, and writes a 16-bit mono WAV file. */
function createWavEncoder(inputRate: number): WavEncoder {
  const step = inputRate / SAMPLE_RATE
  const chunks: Int16Array<ArrayBuffer>[] = []
  let sampleCount = 0
  // Where the next output sample starts, in the next input chunk: chunks rarely divide evenly.
  let position = 0

  return {
    get sampleCount() {
      return sampleCount
    },

    append(samples) {
      const output = new Int16Array(Math.max(0, Math.ceil((samples.length - position) / step)))
      let count = 0

      for (; position < samples.length; position += step) {
        // Average the input each output sample stands for: a cheap low-pass against aliasing.
        const from = Math.floor(position)
        const to = Math.min(samples.length, Math.max(from + 1, Math.floor(position + step)))
        let sum = 0
        for (let index = from; index < to; index += 1) sum += samples[index] ?? 0

        output[count] = toPcm16(sum / (to - from))
        count += 1
      }

      position -= samples.length
      chunks.push(output.subarray(0, count))
      sampleCount += count
    },

    encode() {
      return new Blob([wavHeader(sampleCount), ...chunks], { type: "audio/wav" })
    },
  }
}

function toPcm16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample))
  return Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff)
}

function wavHeader(sampleCount: number): ArrayBuffer {
  const dataBytes = sampleCount * 2
  const header = new DataView(new ArrayBuffer(44))
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      header.setUint8(offset + index, value.charCodeAt(index))
    }
  }

  text(0, "RIFF")
  header.setUint32(4, 36 + dataBytes, true)
  text(8, "WAVE")
  text(12, "fmt ")
  header.setUint32(16, 16, true)
  header.setUint16(20, 1, true) // PCM
  header.setUint16(22, 1, true) // mono
  header.setUint32(24, SAMPLE_RATE, true)
  header.setUint32(28, SAMPLE_RATE * 2, true) // bytes per second
  header.setUint16(32, 2, true) // bytes per sample
  header.setUint16(34, 16, true) // bits per sample
  text(36, "data")
  header.setUint32(40, dataBytes, true)
  return header.buffer
}

type SoundMeter = {
  /** Takes each captured chunk: reports its level, and whether the microphone hears something. */
  measure(samples: Float32Array): void
  reset(): void
}

function createSoundMeter(
  handlers: Pick<SpeechRecognizerHandlers, "onAudioActivity" | "onAudioLevel">
): SoundMeter {
  let active = false
  let heardAt = Number.NEGATIVE_INFINITY

  return {
    measure(samples) {
      const loudness = rootMeanSquare(samples)
      handlers.onAudioLevel?.(perceivedLevel(loudness))

      const now = performance.now()
      if (loudness > SOUND_LEVEL) heardAt = now

      const next = now - heardAt < SOUND_HOLD_MS
      if (next === active) return
      active = next
      handlers.onAudioActivity?.(active)
    },

    reset() {
      handlers.onAudioLevel?.(0)
      if (!active) return
      active = false
      handlers.onAudioActivity?.(false)
    },
  }
}

/** Loudness on the scale ears hear it, in decibels, mapped from 0 to 1. */
function perceivedLevel(rootMeanSquare: number): number {
  const decibels = 20 * Math.log10(Math.max(rootMeanSquare, 1e-6))
  const level = (decibels - LEVEL_FLOOR_DB) / (LEVEL_CEILING_DB - LEVEL_FLOOR_DB)
  return Math.max(0, Math.min(1, level))
}

function rootMeanSquare(samples: Float32Array): number {
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return Math.sqrt(sum / samples.length)
}
