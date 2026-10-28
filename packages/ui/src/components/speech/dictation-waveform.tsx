"use client"

import { useEffect, useRef } from "react"
import type { SpeechRecognitionState } from "../../hooks/use-speech-recognition"
import { cn } from "../../lib/utils"

/** The height a silent bar keeps, as a share of the full height, so the line stays visible. */
const MIN_BAR_SCALE = 0.12

export type DictationWaveformProps = {
  /** State from `useSpeechRecognition` or `useDictation`, whose recognizer measures the level. */
  readonly dictation: SpeechRecognitionState
  /** How many recent levels are drawn, newest on the right. Bars that do not fit are clipped. */
  readonly bars?: number
  readonly className?: string
}

/**
 * The voice being recorded, as bars scrolling from right to left. Levels arrive many times a
 * second, so they are drawn straight into the DOM instead of through React state. Bars take the
 * text color; the line freezes as is once recording stops.
 */
export function DictationWaveform({ dictation, bars = 96, className }: DictationWaveformProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const levelsRef = useRef<number[]>([])
  const { subscribeToAudioLevel } = dictation
  const starting = dictation.status === "starting"

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // A new recording starts from a flat line.
    if (starting) levelsRef.current = []

    const elements = Array.from(container.children, (child) => child as HTMLElement)
    const draw = () => {
      const levels = levelsRef.current
      const offset = elements.length - levels.length
      elements.forEach((element, index) => {
        const level = levels[index - offset] ?? 0
        element.style.transform = `scaleY(${Math.max(MIN_BAR_SCALE, level)})`
      })
    }

    draw()
    return subscribeToAudioLevel((level) => {
      levelsRef.current = [...levelsRef.current, level].slice(-bars)
      draw()
    })
  }, [bars, starting, subscribeToAudioLevel])

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className={cn("flex h-6 items-center justify-end gap-[3px] overflow-hidden", className)}
    >
      {Array.from({ length: bars }, (_, index) => (
        <span
          key={index}
          className="h-full w-[2px] shrink-0 rounded-full bg-current motion-safe:transition-transform motion-safe:duration-75"
          style={{ transform: `scaleY(${MIN_BAR_SCALE})` }}
        />
      ))}
    </div>
  )
}
