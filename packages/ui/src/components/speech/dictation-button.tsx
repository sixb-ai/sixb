"use client"

import { MicIcon } from "lucide-react"
import type { SpeechRecognitionState } from "../../hooks/use-speech-recognition"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"
import { Spinner } from "../ui/spinner"

export type DictationButtonProps = {
  /** State from `useSpeechRecognition` or `useDictation`. */
  readonly dictation: SpeechRecognitionState
  /**
   * What is being dictated, used in the accessible label — e.g. "scope of work"
   * becomes "Start scope of work dictation".
   */
  readonly label?: string
  readonly disabled?: boolean
  /**
   * Blocks starting while another dictation owns the microphone, without making
   * the control look broken.
   */
  readonly busyReason?: string
  readonly className?: string
  readonly size?: React.ComponentProps<typeof Button>["size"]
  readonly variant?: React.ComponentProps<typeof Button>["variant"]
}

/**
 * Microphone toggle for a dictation session.
 *
 * Reflects the four states the recognizer reports: a spinner while starting or
 * stopping, a pulsing icon while audio is actually arriving, and a disabled
 * control when the browser cannot recognize speech at all.
 */
export function DictationButton({
  dictation,
  label,
  disabled,
  busyReason,
  className,
  size = "icon",
  variant = "outline",
}: DictationButtonProps) {
  const { isActive, isReceivingAudio, status, supported, start, stop } = dictation
  const transitioning = status === "starting" || status === "stopping"
  const subject = label ? `${label.toLowerCase()} ` : ""

  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      aria-label={isActive ? `Stop ${subject}dictation` : `Start ${subject}dictation`}
      aria-pressed={isActive}
      disabled={disabled || Boolean(busyReason) || supported !== true || transitioning}
      onClick={isActive ? stop : start}
      title={
        isActive
          ? "Stop dictation"
          : (busyReason ??
            (supported === false ? "Dictation isn't supported in this browser" : "Start dictation"))
      }
      className={cn(
        "rounded-full bg-card shadow-sm",
        status === "listening" &&
          "border-destructive/35 bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive dark:bg-destructive/15 dark:hover:bg-destructive/20",
        className
      )}
    >
      {transitioning ? (
        <Spinner className="size-4" />
      ) : (
        <MicIcon
          aria-hidden="true"
          className={cn("size-4", isReceivingAudio && "dictation-mic-receiving")}
        />
      )}
    </Button>
  )
}
