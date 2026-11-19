// The player's keys, as the players people know have them: Space or K plays and pauses, J and L
// skip ten seconds, the arrows five, and with Shift, or with `,` and `.`, one frame while paused.
// Home and End go to either end, M mutes, F goes fullscreen, and C places a comment.

/** What a key asks of the player. */
export type PlayerKeyAction =
  | { readonly type: "toggle" }
  | { readonly type: "skip"; readonly seconds: number }
  | { readonly type: "step"; readonly frames: number }
  | { readonly type: "start" }
  | { readonly type: "end" }
  | { readonly type: "mute" }
  | { readonly type: "fullscreen" }
  | { readonly type: "comment" }

/** Seconds J and L skip, and the arrows. */
export const SKIP_SECONDS = 10
export const ARROW_SECONDS = 5

/**
 * What a key does, or null for one the player leaves alone: a key with a modifier but Shift, and
 * any key typed into a field. `paused` turns Shift and the arrows into frame steps.
 */
export function playerKeyAction(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">,
  paused: boolean
): PlayerKeyAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null

  switch (event.key) {
    case " ":
    case "k":
    case "K":
      return { type: "toggle" }
    case "j":
    case "J":
      return { type: "skip", seconds: -SKIP_SECONDS }
    case "l":
    case "L":
      return { type: "skip", seconds: SKIP_SECONDS }
    case "ArrowLeft":
      return event.shiftKey && paused
        ? { type: "step", frames: -1 }
        : { type: "skip", seconds: -ARROW_SECONDS }
    case "ArrowRight":
      return event.shiftKey && paused
        ? { type: "step", frames: 1 }
        : { type: "skip", seconds: ARROW_SECONDS }
    case ",":
    case "<":
      return paused ? { type: "step", frames: -1 } : null
    case ".":
    case ">":
      return paused ? { type: "step", frames: 1 } : null
    case "Home":
      return { type: "start" }
    case "End":
      return { type: "end" }
    case "m":
    case "M":
      return { type: "mute" }
    case "f":
    case "F":
      return { type: "fullscreen" }
    case "c":
    case "C":
      return { type: "comment" }
    default:
      return null
  }
}

/** Whether a key's target takes typing of its own: a field, or a button Space presses. */
export function typesItself(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest("input, textarea, select, [contenteditable]")) return true

  // A focused button or menu item answers Space and Enter itself.
  return (
    (key === " " || key === "Enter") &&
    target.closest('button, [role="button"], [role="menuitem"], a[href]') !== null
  )
}
