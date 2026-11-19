import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  controlMessage,
  type HyperframesControl,
  initialPlayback,
  type PlaybackState,
  playbackAfter,
  readReport,
  type SeekMode,
} from "./hyperframes"

// A video's playback in its frame: the state the runtime reports, and the controls that change it.
// Each control is posted at once, in the reader's own gesture: on a phone, only what that gesture
// starts may make a sound, and WebKit carries it across to the frame with the message.

/** How long a seek holds the playhead where the reader put it while older reports arrive. */
const SEEK_HOLD_MS = 400

export interface Playback extends PlaybackState {
  readonly play: () => void
  readonly pause: () => void
  readonly toggle: () => void
  /** Moves the playhead; a drag shows each frame it passes. Playing goes on after a seek. */
  readonly seek: (seconds: number, mode?: SeekMode) => void
  readonly muted: boolean
  readonly setMuted: (muted: boolean) => void
  /** From 0 to 1. */
  readonly volume: number
  readonly setVolume: (volume: number) => void
  readonly rate: number
  readonly setRate: (rate: number) => void
}

/**
 * Plays the video in the frame whose window `frame` returns, at `fps` frames a second; `duration`
 * is how long publishing read it, until the runtime says. `key` changes with each frame loaded:
 * a new frame starts from its own state, where the reader left the last one.
 */
export function usePlayback({
  frame,
  key,
  fps,
  duration,
}: {
  readonly frame: () => Window | null
  readonly key: string | undefined
  readonly fps: number
  readonly duration: number
}): Playback {
  const [state, setState] = useState(() => initialPlayback(duration))
  const [muted, setMutedState] = useState(false)
  const [volume, setVolumeState] = useState(1)
  const [rate, setRateState] = useState(1)

  const held = useRef<{ readonly seconds: number; readonly until: number } | null>(null)
  const latest = useRef(state)
  latest.current = state
  const settings = useRef({ muted, volume, rate })
  settings.current = { muted, volume, rate }

  const post = useCallback(
    (control: HyperframesControl) => {
      frame()?.postMessage(controlMessage(control, fps), "*")
    },
    [frame, fps]
  )

  // A new frame starts loading again, with the reader's sound and speed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each frame loaded starts over.
  useEffect(() => {
    setState((current) => ({ ...initialPlayback(current.duration), time: current.time }))
  }, [key])

  useEffect(() => {
    const listen = (event: MessageEvent) => {
      const source = frame()
      if (!source || event.source !== source) return

      const report = readReport(event.data)
      if (!report) return

      // Once the runtime listens, it takes what the reader set before it did.
      if (report.type === "ready") {
        const { muted, volume, rate } = settings.current
        post({ action: "set-idle-heartbeat", slow: true })
        if (muted) post({ action: "set-muted", muted })
        if (volume !== 1) post({ action: "set-volume", volume })
        if (rate !== 1) post({ action: "set-playback-rate", rate })
      }

      // A report sent before the runtime took the reader's seek would move the playhead back.
      const hold = held.current
      if (report.type === "state" && hold) {
        const landed = Math.abs(report.time - hold.seconds) <= 1 / fps
        if (!landed && performance.now() < hold.until) return
        held.current = null
      }

      setState((current) => playbackAfter(current, report))
    }
    window.addEventListener("message", listen)
    return () => window.removeEventListener("message", listen)
  }, [frame, fps, post])

  const seek = useCallback(
    (seconds: number, mode: SeekMode = "commit") => {
      const current = latest.current
      const to = Math.min(Math.max(seconds, 0), current.duration)
      held.current = { seconds: to, until: performance.now() + SEEK_HOLD_MS }

      post({ action: "seek", seconds: to, mode })
      // HyperFrames pauses on a seek: playing goes on from where it lands.
      if (current.playing && mode === "commit") post({ action: "play" })

      setState((state) => ({ ...state, time: to, ended: false }))
    },
    [post]
  )

  const play = useCallback(() => {
    const current = latest.current
    // At the end, playing starts over.
    if (current.ended || current.time >= current.duration - 1 / fps) {
      held.current = { seconds: 0, until: performance.now() + SEEK_HOLD_MS }
      post({ action: "seek", seconds: 0 })
      setState((state) => ({ ...state, time: 0 }))
    }
    post({ action: "play" })
    setState((state) => ({ ...state, playing: true, ended: false }))
  }, [post, fps])

  const pause = useCallback(() => {
    post({ action: "pause" })
    setState((state) => ({ ...state, playing: false }))
  }, [post])

  const toggle = useCallback(() => {
    if (latest.current.playing) pause()
    else play()
  }, [play, pause])

  const setMuted = useCallback(
    (next: boolean) => {
      post({ action: "set-muted", muted: next })
      setMutedState(next)
      // Unmuted by the reader's own gesture, the sound the browser held back may play.
      if (!next) setState((state) => ({ ...state, soundBlocked: false }))
    },
    [post]
  )

  const setVolume = useCallback(
    (next: number) => {
      const level = Math.min(Math.max(next, 0), 1)
      post({ action: "set-volume", volume: level })
      setVolumeState(level)
      if (level > 0 && settings.current.muted) setMuted(false)
    },
    [post, setMuted]
  )

  const setRate = useCallback(
    (next: number) => {
      post({ action: "set-playback-rate", rate: next })
      setRateState(next)
    },
    [post]
  )

  return useMemo(
    () => ({
      ...state,
      play,
      pause,
      toggle,
      seek,
      muted,
      setMuted,
      volume,
      setVolume,
      rate,
      setRate,
    }),
    [state, play, pause, toggle, seek, muted, setMuted, volume, setVolume, rate, setRate]
  )
}
