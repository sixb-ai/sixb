// A message the running turn reads leaves the tray for its place in the conversation. The tray's
// line folds away as the conversation's copy rises from where the line was, so the message seems
// to move instead of vanishing in one place and appearing in another.

/** Marks a tray line's text with the key its message will have in the conversation. */
export const TRAY_MESSAGE_ATTRIBUTE = "data-tray-message"

/** The key a tray message has in the conversation once read: its saved message's own. */
export function trayMessageKey(messageId: string): string {
  return `message:${messageId}`
}

/** As the rest of the agent's motion: quick to start, gentle to land. */
const EASING = "cubic-bezier(0.32, 0.72, 0, 1)"

/**
 * Bring `element`, the conversation's copy of the message keyed `key`, into place: from its tray
 * line when the tray still shows it, or by a short fade where the reader never saw it there.
 */
export function riseFromTray(element: HTMLElement, key: string): void {
  if (typeof element.animate !== "function") return
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return

  const line = document.querySelector(`[${TRAY_MESSAGE_ATTRIBUTE}="${CSS.escape(key)}"]`)
  if (!line) {
    element.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 240, easing: EASING }
    )
    return
  }

  // Only the height: the line's text starts at the left, the conversation's copy at the right.
  const from = line.getBoundingClientRect()
  const to = element.getBoundingClientRect()
  const rise = from.top + from.height / 2 - (to.top + to.height / 2)
  element.animate(
    [
      { opacity: 0.4, transform: `translateY(${rise}px)` },
      { opacity: 1, transform: "none" },
    ],
    { duration: 420, easing: EASING }
  )
}
