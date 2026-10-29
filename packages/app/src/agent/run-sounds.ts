import { createAgentRunSocket, type ReconnectingSocket } from "@sixb/client"
import { isActiveAgentRunStatus } from "./run-presentation"

/**
 * A sound when a turn the reader started ends while they are away from it: in another tab or app,
 * on another page, or in another conversation. Each run is followed on a socket of its own from the
 * moment this tab starts it, so leaving the conversation does not stop the listening; a reload
 * does.
 */

const SOUND_KEY = "sixb:agent-sounds"

export const RUN_SOUND_CHOICES = ["off", "chime", "bell", "pop"] as const
export type RunSoundChoice = (typeof RUN_SOUND_CHOICES)[number]
export type RunSound = Exclude<RunSoundChoice, "off">

/** The sound this browser plays when a turn ends: chime unless the reader chose another. */
export function readRunSound(): RunSoundChoice {
  try {
    const value = globalThis.localStorage?.getItem(SOUND_KEY)
    return RUN_SOUND_CHOICES.find((choice) => choice === value) ?? "chime"
  } catch {
    return "chime"
  }
}

export function writeRunSound(choice: RunSoundChoice) {
  try {
    globalThis.localStorage?.setItem(SOUND_KEY, choice)
  } catch {
    // Ignore storage errors.
  }
}

/** The turn is over, or one of its calls waits for the reader's decision. */
export type RunTone = "done" | "waiting"

/** One note: when it starts and how long it rings, in seconds, and its pitch in Hz. */
interface Note {
  readonly frequency: number
  readonly at: number
  readonly length: number
  readonly gain?: number
  /** The pitch it slides to as it fades. */
  readonly glideTo?: number
}

const PEAK_GAIN = 0.12

const chime = (frequency: number, at: number): Note => ({ frequency, at, length: 0.35 })

// A struck bell: its note, and two quieter overtones that fade sooner.
const strike = (frequency: number, at: number): readonly Note[] => [
  { frequency, at, length: 1.4, gain: 0.1 },
  { frequency: frequency * 2, at, length: 0.7, gain: 0.035 },
  { frequency: frequency * 3, at, length: 0.4, gain: 0.015 },
]

const pop = (at: number): Note => ({ frequency: 600, at, length: 0.1, gain: 0.2, glideTo: 300 })

// Each sound says the two apart the same way: waiting repeats itself.
const SOUNDS: Record<RunSound, Record<RunTone, readonly Note[]>> = {
  chime: {
    done: [chime(659.25, 0), chime(987.77, 0.12)],
    waiting: [chime(880, 0), chime(880, 0.12)],
  },
  bell: {
    done: strike(1046.5, 0),
    waiting: [...strike(783.99, 0), ...strike(783.99, 0.28)],
  },
  pop: {
    done: [pop(0)],
    waiting: [pop(0), pop(0.13)],
  },
}

let audio: AudioContext | null = null

// A browser lets a page start audio only once the reader has interacted with it, so the context is
// made as the reader starts a turn, and kept.
function audioContext(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null
  audio ??= new AudioContext()
  // A page the browser does not let play stays silent.
  if (audio.state === "suspended") audio.resume().catch(() => {})
  return audio
}

export function playRunSound(sound: RunSound, tone: RunTone) {
  const context = audioContext()
  if (!context) return

  const start = context.currentTime + 0.02
  for (const note of SOUNDS[sound][tone]) {
    const at = start + note.at
    const end = at + note.length
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.frequency.setValueAtTime(note.frequency, at)
    if (note.glideTo) oscillator.frequency.exponentialRampToValueAtTime(note.glideTo, end)
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(note.gain ?? PEAK_GAIN, at + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, end)
    oscillator.connect(gain).connect(context.destination)
    oscillator.start(at)
    oscillator.stop(end)
  }
}

const followed = new Map<string, ReconnectingSocket>()

/**
 * Follow a run this tab just started until it ends, and play its tone unless the reader watched it
 * end. Call it where the turn starts, close to the reader's click or key.
 */
export function watchRun(run: { readonly id: string; readonly threadId: string }) {
  if (typeof window === "undefined" || followed.has(run.id) || readRunSound() === "off") return
  audioContext()

  // Closing the socket drops what it still receives, so a run ends once.
  const end = (ended: { readonly status: string; readonly finishReason?: string }) => {
    followed.get(run.id)?.close()
    followed.delete(run.id)

    // The sound chosen now, though the reader may have changed it while the turn ran.
    const sound = readRunSound()
    const tone = runTone(ended)
    if (tone && sound !== "off" && !watching(run.threadId)) playRunSound(sound, tone)
  }

  followed.set(
    run.id,
    createAgentRunSocket({
      runId: run.id,
      onEvent: (event) => {
        if (event.type === "agent.run.finished") end(event)
      },
      // A run that ended before the socket subscribed shows it in its snapshot.
      onRunSnapshot: (snapshot) => {
        if (!isActiveAgentRunStatus(snapshot.status)) end(snapshot)
      },
    })
  )
}

// A stopped turn makes no sound: whoever stopped it knows. A failed one is over all the same.
function runTone(ended: {
  readonly status: string
  readonly finishReason?: string
}): RunTone | null {
  if (ended.status === "cancelled") return null
  return ended.status === "succeeded" && ended.finishReason === "awaiting_approval"
    ? "waiting"
    : "done"
}

/**
 * Whether the reader sees the conversation now: this tab in front and focused, and a transcript of
 * it on screen. Its middle is hit-tested, so a collapsed panel, an inert one or one covered by
 * another view does not count.
 */
function watching(threadId: string): boolean {
  if (document.visibilityState !== "visible" || !document.hasFocus()) return false
  for (const element of document.querySelectorAll<HTMLElement>("[data-agent-thread]")) {
    if (element.dataset.agentThread !== threadId) continue
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    if (hit && element.contains(hit)) return true
  }
  return false
}
