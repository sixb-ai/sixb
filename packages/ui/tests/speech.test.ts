import { beforeEach, describe, expect, test } from "bun:test"
import {
  appendDictationText,
  createWebSpeechRecognizer,
  type SpeechErrorCode,
  type SpeechRecognitionConstructor,
  type SpeechResult,
  speechErrorMessage,
  toSpeechErrorCode,
} from "@sixb/ui/lib/speech"

describe("appendDictationText", () => {
  test.each([
    [
      "uses the dictated text when the field is empty",
      "",
      "  Remove the damaged tree.  ",
      "Remove the damaged tree.",
    ],
    [
      "appends to existing text with one separator",
      "Prune the trees.   ",
      "  Remove all debris.",
      "Prune the trees. Remove all debris.",
    ],
    [
      "leaves the field untouched for a blank transcript",
      "Existing scope  ",
      "   ",
      "Existing scope  ",
    ],
  ])("%s", (_label, field, transcript, expected) => {
    expect(appendDictationText(field, transcript)).toBe(expected)
  })
})

describe("speechErrorMessage", () => {
  test("maps permission denial to an actionable message, an abort to none, and the rest to one each", () => {
    expect(speechErrorMessage("not-allowed")).toContain("Microphone access was denied")
    expect(speechErrorMessage("service-not-allowed")).toContain("Microphone access was denied")
    // An intentional abort is not an error.
    expect(speechErrorMessage("aborted")).toBeNull()
    const codes: SpeechErrorCode[] = [
      "audio-capture",
      "language-not-supported",
      "network",
      "no-speech",
      "unknown",
    ]
    for (const code of codes) expect(speechErrorMessage(code)).toBeTruthy()
  })
})

describe("toSpeechErrorCode", () => {
  test("passes known codes through and funnels the rest to unknown", () => {
    expect(toSpeechErrorCode("no-speech")).toBe("no-speech")
    expect(toSpeechErrorCode("audio-capture")).toBe("audio-capture")
    expect(toSpeechErrorCode("something-new")).toBe("unknown")
    expect(toSpeechErrorCode(undefined)).toBe("unknown")
  })
})

describe("createWebSpeechRecognizer", () => {
  beforeEach(() => {
    FakeRecognition.last = null
  })

  test("reports no support without a browser implementation", () => {
    expect(createWebSpeechRecognizer().isSupported()).toBe(false)
    expect(createWebSpeechRecognizer({ implementation: fakeConstructor() }).isSupported()).toBe(
      true
    )
  })

  test("throws when started with no implementation available", () => {
    expect(() => createWebSpeechRecognizer().start({}, {})).toThrow(
      "[SixbUI] Speech recognition is unavailable."
    )
  })

  test("applies start options and defaults to continuous dictation", () => {
    const recognizer = createWebSpeechRecognizer({ implementation: fakeConstructor() })

    recognizer.start({ lang: "es-ES", maxAlternatives: 3 }, {})
    expect(lastInstance()).toMatchObject({
      lang: "es-ES",
      maxAlternatives: 3,
      continuous: true,
      interimResults: true,
      started: 1,
    })

    // Explicitly disabled continuous and interim results are honoured.
    recognizer.start({ continuous: false, interimResults: false }, {})
    expect(lastInstance()).toMatchObject({ continuous: false, interimResults: false })
  })

  test.each([
    [
      "reports interim text before the final result that replaces it",
      {
        resultIndex: 0,
        results: [
          { isFinal: true, 0: { transcript: "Remove the tree." } },
          { isFinal: false, 0: { transcript: "and haul away" } },
        ],
      },
      [
        { transcript: "and haul away", isFinal: false },
        { transcript: "Remove the tree.", isFinal: true },
      ],
    ],
    [
      "reads only from resultIndex onward and skips empty alternatives",
      {
        resultIndex: 1,
        results: [
          { isFinal: true, 0: { transcript: "already delivered" } },
          { isFinal: true, 0: { transcript: "" } },
          { isFinal: true, 0: undefined },
          { isFinal: true, 0: { transcript: "second chunk" } },
        ],
      },
      [{ transcript: "second chunk", isFinal: true }],
    ],
    [
      "joins multiple final chunks from one event",
      {
        resultIndex: 0,
        results: [
          { isFinal: true, 0: { transcript: "first" } },
          { isFinal: true, 0: { transcript: "second" } },
        ],
      },
      [{ transcript: "first second", isFinal: true }],
    ],
  ])("%s", (_label, event, expected) => {
    const results: SpeechResult[] = []
    const recognizer = createWebSpeechRecognizer({ implementation: fakeConstructor() })

    recognizer.start({}, { onResult: (result) => results.push(result) })
    call(lastInstance().onresult, event)

    expect(results).toEqual(expected)
  })

  test("treats either sound or speech as incoming audio", () => {
    const activity: boolean[] = []
    const recognizer = createWebSpeechRecognizer({ implementation: fakeConstructor() })

    recognizer.start({}, { onAudioActivity: (active) => activity.push(active) })
    const instance = lastInstance()

    call(instance.onsoundstart, {})
    call(instance.onspeechstart, {})
    // Sound ends but speech is still detected, so audio is still arriving.
    call(instance.onsoundend, {})
    call(instance.onspeechend, {})

    expect(activity).toEqual([true, true, true, false])
  })

  test("normalizes error names and forwards lifecycle events", () => {
    const codes: SpeechErrorCode[] = []
    let started = 0
    let ended = 0
    const recognizer = createWebSpeechRecognizer({ implementation: fakeConstructor() })

    recognizer.start(
      {},
      {
        onStart: () => {
          started += 1
        },
        onEnd: () => {
          ended += 1
        },
        onError: (code) => codes.push(code),
      }
    )
    const instance = lastInstance()

    call(instance.onstart, {})
    call(instance.onerror, { error: "not-allowed" })
    call(instance.onerror, { error: "totally-new" })
    call(instance.onend, {})

    expect(started).toBe(1)
    expect(ended).toBe(1)
    expect(codes).toEqual(["not-allowed", "unknown"])
  })

  test("clears audio activity when a session errors or ends", () => {
    const activity: boolean[] = []
    const recognizer = createWebSpeechRecognizer({ implementation: fakeConstructor() })

    recognizer.start({}, { onAudioActivity: (active) => activity.push(active) })
    const instance = lastInstance()

    call(instance.onsoundstart, {})
    call(instance.onend, {})
    // A fresh sound event after the reset still reports activity.
    call(instance.onsoundstart, {})

    expect(activity).toEqual([true, true])
  })

  test("delegates stop and abort to the browser session", () => {
    const recognizer = createWebSpeechRecognizer({ implementation: fakeConstructor() })

    const session = recognizer.start({}, {})
    const instance = lastInstance()

    session.stop()
    session.abort()

    expect(instance.stopped).toBe(1)
    expect(instance.aborted).toBe(1)
  })
})

/**
 * Stand-in for the browser's SpeechRecognition. Handler fields are `unknown`
 * because the recognizer assigns differently-shaped event callbacks to each;
 * tests invoke them through {@link call}.
 */
class FakeRecognition {
  static last: FakeRecognition | null = null

  continuous = false
  interimResults = false
  lang = ""
  maxAlternatives = 0
  onend: unknown = null
  onerror: unknown = null
  onresult: unknown = null
  onsoundend: unknown = null
  onsoundstart: unknown = null
  onspeechend: unknown = null
  onspeechstart: unknown = null
  onstart: unknown = null
  started = 0
  stopped = 0
  aborted = 0

  constructor() {
    FakeRecognition.last = this
  }

  start() {
    this.started += 1
  }

  stop() {
    this.stopped += 1
  }

  abort() {
    this.aborted += 1
  }
}

function fakeConstructor(): SpeechRecognitionConstructor {
  return FakeRecognition as unknown as SpeechRecognitionConstructor
}

function lastInstance(): FakeRecognition {
  const instance = FakeRecognition.last
  if (!instance) throw new Error("No recognition instance was constructed.")
  return instance
}

/** Invokes a handler the recognizer installed, with the event shape it expects. */
function call<T>(handler: unknown, event: T): void {
  ;(handler as ((event: T) => void) | null)?.(event)
}
