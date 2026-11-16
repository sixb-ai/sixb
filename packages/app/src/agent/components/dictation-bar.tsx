import { DictationWaveform, Spinner } from "@sixb/ui/components"
import type { SpeechRecognitionState } from "@sixb/ui/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { Check, X } from "lucide-react"
import { type KeyboardEvent, useEffect, useState } from "react"
import { useAgentMessages } from "../i18n"

export interface DictationBarProps {
  /** A dictation under way: starting, listening, or transcribing. */
  readonly dictation: SpeechRecognitionState
  /** The ghost buttons' look, so Cancel matches the controls it replaces. */
  readonly buttonClassName: string
  /** The filled control's look, so Done sits where Send was. */
  readonly doneClassName: string
}

/**
 * The composer while a message is dictated: cancel, the voice as a waveform, a recording dot with
 * how long it has run, and Done. While the words are transcribed the waveform freezes and dims
 * under a passing sheen, and Done waits. Done takes the focus, so Enter or Space finishes and
 * Escape cancels.
 */
export function DictationBar({ dictation, buttonClassName, doneClassName }: DictationBarProps) {
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
    <div
      className="flex h-10 min-w-0 flex-1 items-center gap-2 group-data-[expanded]/composer:basis-full"
      onKeyDown={cancelOnEscape}
    >
      <button
        type="button"
        onClick={dictation.abort}
        aria-label={messages.cancelDictation}
        title={messages.cancelDictation}
        className={buttonClassName}
      >
        <X className="size-[18px]" strokeWidth={1.9} />
      </button>

      <div
        data-transcribing={transcribing || undefined}
        className="sixb-dictation-wave relative min-w-0 flex-1 text-foreground/55"
      >
        <DictationWaveform dictation={dictation} className="h-7 [&>span]:w-[3px]" />
      </div>

      <span
        aria-hidden="true"
        data-transcribing={transcribing || undefined}
        className="sixb-dictation-dot size-1.5 shrink-0 rounded-full"
      />
      <span
        className="min-w-[30px] shrink-0 text-[12.5px] text-muted-foreground tabular-nums"
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
        className={cn(doneClassName, "aria-disabled:bg-foreground/40")}
      >
        {transcribing ? (
          <Spinner className="size-4" />
        ) : (
          <Check className="size-[17px]" strokeWidth={2.4} />
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
