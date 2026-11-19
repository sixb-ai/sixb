// What the app's players of video and sound share: their frame, their clock, and a recording's
// duration.

/** The ring and soft shadow a player sits in, on a light or a dark surface. */
export const MEDIA_FRAME =
  "ring-1 ring-black/[0.06] shadow-[0_1px_2px_rgb(0_0_0/0.05),0_10px_28px_-12px_rgb(0_0_0/0.22)] dark:ring-white/10 dark:shadow-[0_1px_2px_rgb(0_0_0/0.4),0_10px_28px_-12px_rgb(0_0_0/0.7)]"

/** `m:ss`, or `h:mm:ss` past an hour: the whole seconds played, as players count them. */
export function formatClock(seconds: number): string {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = String(whole % 60).padStart(2, "0")
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`
}

/**
 * Finds the duration of a recording written as it was captured, by a browser's `MediaRecorder` or
 * by Playwright: its WebM header holds none, and the element says `Infinity` until it has read to
 * the end. A seek past the end makes it read the end; once the duration is known, it goes back to
 * the start. Call it when the metadata loads.
 */
export function revealDuration(element: HTMLMediaElement): void {
  if (element.duration !== Number.POSITIVE_INFINITY) return

  const rewind = () => {
    if (!Number.isFinite(element.duration)) return
    element.removeEventListener("durationchange", rewind)
    element.currentTime = 0
  }
  element.addEventListener("durationchange", rewind)
  element.currentTime = Number.MAX_SAFE_INTEGER
}
