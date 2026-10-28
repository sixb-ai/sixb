import { DictationWaveform, Spinner } from "@sixb/ui/components"
import type { SpeechRecognitionState } from "@sixb/ui/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { Check, X } from "lucide-react"
import { type KeyboardEvent, useEffect, useState } from "react"
import { useAgentMessages } from "../i18n"

export interface DictationBarProps {
  /** A dictation under way: starting, listening, or transcribing. */
  readonly dictation: SpeechRecognitionState
  /** The filled control's look, so Done sits where Send was. */
  readonly doneClassName: string
}

/**
 * The composer's toolbar while a message is dictated: cancel, the voice as a waveform, how long it
 * has run, and Done. Done takes the focus, so Enter or Space finishes and Escape cancels.
 */
export function DictationBar({ dictation, doneClassName }: DictationBarProps) {
  const messages = useAgentMessages().composer
  const transcribing = dictation.status === "stopping"
  const seconds = useRecordingSeconds(dictation.status === "listening")

  const cancelOnEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    event.preventDefault()
    dictation.abort()
  }

  return (
    // Escape is a shortcut: both buttons stay reachable with the keyboard.
    <div className="flex min-w-0 flex-1 items-center gap-2" onKeyDown={cancelOnEscape}>
      <button
        type="button"
        onClick={dictation.abort}
        aria-label={messages.cancelDictation}
        title={messages.cancelDictation}
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors",
          "hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40"
        )}
      >
        <X className="size-[18px]" strokeWidth={1.75} />
      </button>

      <DictationWaveform
        dictation={dictation}
        className={cn(
          "min-w-0 flex-1 text-foreground/60 transition-opacity duration-300",
          transcribing && "opacity-30"
        )}
      />

      <span
        className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums"
        aria-hidden="true"
      >
        {formatSeconds(seconds)}
      </span>
      <span className="sr-only" role="status">
        {transcribing ? messages.dictationTranscribing : messages.dictationListening}
      </span>

      <button
        type="button"
        // The reader just pressed the microphone: Done is what comes next. It stays focusable while
        // transcribing, so the focus, and Escape with it, stay in the bar.
        autoFocus
        onClick={transcribing ? undefined : dictation.stop}
        aria-disabled={transcribing}
        aria-label={messages.finishDictation}
        title={messages.finishDictation}
        className={cn(
          doneClassName,
          "ml-1 aria-disabled:bg-foreground/25 dark:aria-disabled:bg-white/20"
        )}
      >
        {transcribing ? (
          <Spinner className="size-3.5" />
        ) : (
          <Check className="size-4" strokeWidth={2.25} />
        )}
      </button>
    </div>
  )
}

/** Whole seconds since recording started, held while it is transcribed. */
function useRecordingSeconds(recording: boolean): number {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    if (!recording) return

    const startedAt = Date.now()
    setSeconds(0)
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 250)
    return () => clearInterval(timer)
  }, [recording])

  return seconds
}

function formatSeconds(total: number): string {
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}
