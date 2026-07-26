"use client"

import { useId } from "react"
import { useDictation } from "../../hooks/use-dictation"
import type { SpeechRecognitionState } from "../../hooks/use-speech-recognition"
import type { SpeechRecognizer } from "../../lib/speech"
import { appendDictationText } from "../../lib/speech"
import { cn } from "../../lib/utils"
import { Field, FieldLabel } from "../ui/field"
import { Textarea } from "../ui/textarea"
import { DictationButton } from "./dictation-button"

export type DictationTextareaProps = {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly label?: string
  readonly placeholder?: string
  readonly disabled?: boolean
  readonly id?: string
  readonly className?: string
  readonly textareaClassName?: string
  readonly rows?: number
  /**
   * Supply the state when the app needs the hook outside this component — for
   * example to keep two microphones from running at once. Omit it and the
   * component manages its own dictation.
   */
  readonly dictation?: SpeechRecognitionState
  readonly recognizer?: SpeechRecognizer
  readonly lang?: string
  /** Reason the microphone is unavailable right now; shown in the button title. */
  readonly busyReason?: string
  /** Prevents typing over text that dictation is still appending to. */
  readonly readOnlyWhileListening?: boolean
  /** Show in-progress speech in the field before the recognizer finalizes it. */
  readonly showInterim?: boolean
  readonly unsupportedMessage?: string
}

/**
 * Textarea with a built-in microphone, for free-text fields that are quicker to
 * speak than to type.
 *
 * Dictation appends to whatever the field already holds, and the field goes
 * read-only while listening so typed and spoken text cannot interleave.
 */
export function DictationTextarea({
  value,
  onChange,
  label,
  placeholder,
  disabled,
  id,
  className,
  textareaClassName,
  rows = 5,
  dictation,
  recognizer,
  lang,
  busyReason,
  readOnlyWhileListening = true,
  showInterim = true,
  unsupportedMessage = "Voice dictation isn't supported in this browser. You can still type instead.",
}: DictationTextareaProps) {
  const generatedId = useId()
  const fieldId = id ?? `${generatedId}-dictation`
  const statusId = `${generatedId}-status`

  // Always called so the hook order is stable; ignored when the caller owns the state.
  const ownDictation = useDictation({ value, onChange, disabled, recognizer, lang })
  const state = dictation ?? ownDictation

  const statusMessage =
    state.status === "starting"
      ? "Waiting for microphone permission…"
      : state.status === "listening"
        ? "Listening… Press stop when you're finished."
        : state.status === "stopping"
          ? "Finishing dictation…"
          : state.supported === false
            ? unsupportedMessage
            : null

  const displayValue =
    showInterim && state.interimTranscript
      ? appendDictationText(value, state.interimTranscript)
      : value

  return (
    <Field className={cn("min-w-0", className)}>
      {label ? <FieldLabel htmlFor={fieldId}>{label}</FieldLabel> : null}

      {state.error || statusMessage ? (
        <div id={statusId}>
          {state.error ? (
            <p className="text-xs font-medium text-destructive" role="alert">
              {state.error}
            </p>
          ) : (
            <p
              // Transient progress is for screen readers only; a browser that
              // cannot dictate at all needs the message on screen.
              className={state.supported === false ? "text-xs text-muted-foreground" : "sr-only"}
              role="status"
            >
              {statusMessage}
            </p>
          )}
        </div>
      ) : null}

      <div className="relative min-w-0">
        <Textarea
          id={fieldId}
          value={displayValue}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={readOnlyWhileListening && state.isActive}
          rows={rows}
          aria-describedby={state.error || statusMessage ? statusId : undefined}
          className={cn("resize-none pr-14 pb-14 text-base leading-6", textareaClassName)}
        />
        <DictationButton
          busyReason={busyReason}
          className="absolute right-3 bottom-3"
          dictation={state}
          disabled={disabled}
          label={label}
        />
      </div>
    </Field>
  )
}
