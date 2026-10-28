import { createAgentRunSocket, type ReconnectingSocket } from "@sixb/client"
import { isActiveAgentRunStatus } from "./run-presentation"

/**
 * A tone when a turn the reader started ends while they are away from it: in another tab or app,
 * on another page, or in another conversation. Each run is followed on a socket of its own from the
 * moment this tab starts it, so leaving the conversation does not stop the listening; a reload
 * does.
 */

const SOUNDS_KEY = "sixb:agent-sounds"

/** Whether this browser plays a tone when a turn ends: on unless the reader turned it off. */
export function readRunSounds(): boolean {
  try {
    return globalThis.localStorage?.getItem(SOUNDS_KEY) !== "off"
  } catch {
    return true
  }
}

export function writeRunSounds(on: boolean) {
  try {
    if (on) globalThis.localStorage?.removeItem(SOUNDS_KEY)
    else globalThis.localStorage?.setItem(SOUNDS_KEY, "off")
  } catch {
    // Ignore storage errors.
  }
}

export type RunTone = "done" | "waiting"

// Frequencies in Hz, played one after the other.
const TONES: Record<RunTone, readonly number[]> = {
  // A rising fifth: the answer is in.
  done: [659.25, 987.77],
  // One note twice: a call waits for the reader's decision.
  waiting: [880, 880],
}
const NOTE_SECONDS = 0.35
const NOTE_GAP_SECONDS = 0.12
const PEAK_GAIN = 0.12

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

export function playRunTone(tone: RunTone) {
  const context = audioContext()
  if (!context) return

  const start = context.currentTime + 0.02
  TONES[tone].forEach((frequency, index) => {
    const at = start + index * NOTE_GAP_SECONDS
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.frequency.value = frequency
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, at + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_SECONDS)
    oscillator.connect(gain).connect(context.destination)
    oscillator.start(at)
    oscillator.stop(at + NOTE_SECONDS)
  })
}

const followed = new Map<string, ReconnectingSocket>()

/**
 * Follow a run this tab just started until it ends, and play its tone unless the reader watched it
 * end. Call it where the turn starts, close to the reader's click or key.
 */
export function watchRun(run: { readonly id: string; readonly threadId: string }) {
  if (typeof window === "undefined" || followed.has(run.id) || !readRunSounds()) return
  audioContext()

  // Closing the socket drops what it still receives, so a run ends once.
  const end = (ended: { readonly status: string; readonly finishReason?: string }) => {
    followed.get(run.id)?.close()
    followed.delete(run.id)

    const tone = runTone(ended)
    if (tone && readRunSounds() && !watching(run.threadId)) playRunTone(tone)
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
