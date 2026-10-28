import { describe, expect, test } from "bun:test"
import type { SpeechRecognizer, SpeechRecognizerHandlers } from "@sixb/ui/lib/speech"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render } from "@testing-library/react"
import { Composer, type ComposerProps } from "../src/agent/components/composer"
import { installDom } from "./helpers/dom"

installDom([
  "document",
  "navigator",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Event",
  "CustomEvent",
  "EventTarget",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "PointerEvent",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
])

type FakeSession = {
  readonly handlers: SpeechRecognizerHandlers
  stopped: boolean
  aborted: boolean
}

/** A recognizer the test plays: each session's handlers are called by hand. */
function fakeRecognizer() {
  const sessions: FakeSession[] = []
  const recognizer: SpeechRecognizer = {
    id: "fake",
    isSupported: () => true,
    start: (_options, handlers) => {
      const session: FakeSession = { handlers, stopped: false, aborted: false }
      sessions.push(session)
      return {
        stop: () => {
          session.stopped = true
        },
        abort: () => {
          session.aborted = true
          handlers.onEnd?.()
        },
      }
    },
  }

  return { recognizer, sessions }
}

function renderComposer(props: Partial<ComposerProps>) {
  const queryClient = new QueryClient()
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Composer onSend={() => {}} {...props} />
    </QueryClientProvider>
  )
  const rerender = (next: Partial<ComposerProps>) =>
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <Composer onSend={() => {}} {...props} {...next} />
      </QueryClientProvider>
    )
  const input = () => view.getByLabelText("Message") as HTMLTextAreaElement
  return { ...view, rerender, input }
}

/** Presses the microphone and opens it: the recording bar is up. */
function startDictation(view: ReturnType<typeof renderComposer>, session: () => FakeSession) {
  fireEvent.click(view.getByLabelText("Start dictation"))
  act(() => session().handlers.onStart?.())
  expect(view.getByLabelText("Done")).toBeTruthy()
}

describe("Composer dictation", () => {
  // Removal proof: drop onAudioEnd from useSpeechRecognition; the bar still says it listens.
  test("a recording that stops on its own shows as transcribing", () => {
    const { recognizer, sessions } = fakeRecognizer()
    const view = renderComposer({ dictation: recognizer })
    startDictation(view, () => sessions[0]!)

    act(() => sessions[0]?.handlers.onAudioEnd?.())

    expect(view.input().placeholder).toBe("Transcribing…")
    expect(view.getByLabelText("Done").getAttribute("aria-disabled")).toBe("true")
  })

  test("the transcript lands in the input, focused with the caret after it", () => {
    const { recognizer, sessions } = fakeRecognizer()
    const view = renderComposer({ dictation: recognizer })
    startDictation(view, () => sessions[0]!)

    act(() => {
      sessions[0]?.handlers.onResult?.({ transcript: "Remind Alice", isFinal: true })
      sessions[0]?.handlers.onEnd?.()
    })

    expect(view.input().value).toBe("Remind Alice")
    expect(document.activeElement).toBe(view.input())
    expect(view.input().selectionStart).toBe("Remind Alice".length)
  })

  // Removal proof: drop the effect that refocuses the input; the focus stays on the body.
  test("a cancelled dictation gives the focus back to the input", () => {
    const { recognizer, sessions } = fakeRecognizer()
    const view = renderComposer({ dictation: recognizer })
    startDictation(view, () => sessions[0]!)

    fireEvent.click(view.getByLabelText("Cancel dictation"))

    expect(sessions[0]?.aborted).toBe(true)
    expect(view.queryByLabelText("Done")).toBeNull()
    expect(document.activeElement).toBe(view.input())
  })

  // Removal proof: pass the composer's `disabled` to useDictation; the recording is aborted.
  test("someone else's turn disabling the composer keeps the recording going", () => {
    const { recognizer, sessions } = fakeRecognizer()
    const view = renderComposer({ dictation: recognizer })
    startDictation(view, () => sessions[0]!)

    view.rerender({ disabled: true })

    expect(sessions[0]?.aborted).toBe(false)
    fireEvent.click(view.getByLabelText("Done"))
    expect(sessions[0]?.stopped).toBe(true)
  })

  test("a disabled composer does not start a dictation", () => {
    const { recognizer, sessions } = fakeRecognizer()
    const view = renderComposer({ dictation: recognizer, disabled: true })

    fireEvent.click(view.getByLabelText("Start dictation"))

    expect(sessions).toHaveLength(0)
  })
})
