import { useEffect, useLayoutEffect } from "react"
import { isInstalledApp } from "./phone-dom"

/**
 * Android resizes the layout for the keyboard, and fields never zoom on focus because
 * phone-shell.css keeps them at 16px. Pinch-zoom stays available in the browser and is only
 * switched off in the installed app, where it would break the illusion of a native screen.
 */
const VIEWPORT =
  "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"

// Below this the browser's own toolbars are moving, not a keyboard.
const KEYBOARD_THRESHOLD = 80
// The tallest keyboard measured, per viewport size, so the next one is predicted from experience.
const KEYBOARD_STORAGE_KEY = "sixb:keyboard-height"
// How long a predicted keyboard may take to appear before we assume a hardware keyboard.
const KEYBOARD_GRACE_MS = 900
// Sixb's chat composer, and how long after a touch on it a focus still counts as asked for.
const COMPOSER = ".sixb-composer-surface"
const COMPOSER_TAP_MS = 1000

/**
 * Keeps the app above the on-screen keyboard, the way a native app does: the screen stays put,
 * and only what sits at the bottom, a composer or a sheet, rides up with the keyboard.
 *
 * iOS overlays the keyboard and scrolls the whole document to reveal a field that would end up
 * behind it, which slides the entire app off the top of the screen. So the moment a field takes
 * focus, the shell shrinks by the keyboard's expected height (`--keyboard-inset`, learned from the
 * last time it opened). The field is then already clear of the keyboard and iOS has nothing to
 * scroll. When the keyboard settles, the real height replaces the prediction, and any scroll iOS
 * still made is undone. `data-keyboard` on <html> marks the whole time a field has the keyboard.
 *
 * Android resizes the layout itself (`interactive-widget=resizes-content`), so there the inset
 * stays zero and only `data-keyboard` applies.
 *
 * The chat's composer focuses itself on arrival, on returning to the app and after each answer.
 * On a touch screen that would raise the keyboard over the page, so, as in native chat apps, it
 * waits for a tap instead; while the keyboard is already up, it keeps the focus it is given.
 */
export function ViewportController() {
  // A layout effect, so it already listens when the composer's autofocus runs on first render.
  useLayoutEffect(() => {
    if (!matchMedia("(pointer: coarse)").matches) return
    let tappedAt = Number.NEGATIVE_INFINITY

    // The end of the touch too: a long press focuses the field only once it lifts.
    const onTouch = (event: TouchEvent) => {
      if (event.target instanceof Element && event.target.closest(COMPOSER)) {
        tappedAt = performance.now()
      }
    }
    const unasked = (target: EventTarget | null): target is HTMLTextAreaElement =>
      target instanceof HTMLTextAreaElement &&
      target.closest(COMPOSER) !== null &&
      !document.documentElement.hasAttribute("data-keyboard") &&
      performance.now() - tappedAt > COMPOSER_TAP_MS
    // Ahead of everything else, so neither the keyboard prediction nor the page sees the focus.
    const onFocusIn = (event: FocusEvent) => {
      if (!unasked(event.target)) return
      event.stopImmediatePropagation()
      event.target.blur()
    }

    window.addEventListener("touchstart", onTouch, { capture: true, passive: true })
    window.addEventListener("touchend", onTouch, { capture: true, passive: true })
    window.addEventListener("focusin", onFocusIn, true)
    if (unasked(document.activeElement)) document.activeElement.blur()
    return () => {
      window.removeEventListener("touchstart", onTouch, { capture: true })
      window.removeEventListener("touchend", onTouch, { capture: true })
      window.removeEventListener("focusin", onFocusIn, true)
    }
  }, [])

  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    if (!meta) return
    const previous = meta.content
    meta.content = VIEWPORT
    return () => {
      meta.content = previous
    }
  }, [])

  useEffect(() => {
    if (!isInstalledApp()) return
    const prevent = (event: Event) => event.preventDefault()
    document.addEventListener("gesturestart", prevent)
    return () => document.removeEventListener("gesturestart", prevent)
  }, [])

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport || !matchMedia("(pointer: coarse)").matches) return
    const root = document.documentElement
    const ios = isIOS()
    let inset = 0
    let predictedAt = 0
    let touching = false
    let frame = 0
    let graceTimer = 0
    let closeTimer = 0

    const setInset = (px: number) => {
      if (px === inset) return
      inset = px
      root.style.setProperty("--keyboard-inset", `${px}px`)
    }
    const setOpen = (open: boolean) => root.toggleAttribute("data-keyboard", open)

    // iOS 26 shrinks innerHeight along with the visual viewport; the layout viewport does not move.
    const measured = () => {
      const covered = Math.round(root.clientHeight - viewport.height * viewport.scale)
      return covered > KEYBOARD_THRESHOLD ? covered : 0
    }

    const settle = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const keyboard = measured()
        if (keyboard > 0) {
          predictedAt = 0
          if (ios) {
            rememberKeyboard(keyboard)
            setInset(keyboard)
          }
          setOpen(true)
          if (!touching && window.scrollY !== 0) window.scrollTo(0, 0)
          revealFocusedField()
        } else if (!predictedAt || performance.now() - predictedAt > KEYBOARD_GRACE_MS) {
          // Gone, even if the field kept focus (Done hides the keyboard without blurring).
          predictedAt = 0
          setInset(0)
          setOpen(false)
        }
      })
    }

    const expectKeyboard = () => {
      window.clearTimeout(closeTimer)
      setOpen(true)
      if (ios && inset === 0) {
        // Make room before the keyboard arrives, so iOS never scrolls the app to reveal the field.
        predictedAt = performance.now()
        setInset(expectedKeyboard())
        window.clearTimeout(graceTimer)
        graceTimer = window.setTimeout(settle, KEYBOARD_GRACE_MS + 50)
      } else {
        requestAnimationFrame(revealFocusedField)
      }
    }

    const onFocusIn = (event: FocusEvent) => {
      if (opensKeyboard(event.target)) expectKeyboard()
    }

    // Moving between fields blurs one before focusing the next; only a real dismissal closes.
    const onFocusOut = () => {
      window.clearTimeout(closeTimer)
      closeTimer = window.setTimeout(() => {
        if (hasTextFocus()) return
        predictedAt = 0
        setOpen(false)
        if (measured() === 0) setInset(0)
      }, 120)
    }

    // With the keyboard up iOS lets the whole document be dragged; it springs back on release.
    const onTouchStart = (event: TouchEvent) => {
      touching = true
      // Tapping a field that kept focus after Done brings the keyboard back without a focus event.
      const field =
        event.target instanceof Element
          ? event.target.closest("input, textarea, [contenteditable]")
          : null
      if (field && field === document.activeElement && opensKeyboard(field) && measured() === 0) {
        expectKeyboard()
      }
    }
    const onTouchEnd = () => {
      touching = false
      if (root.hasAttribute("data-keyboard") && window.scrollY !== 0) window.scrollTo(0, 0)
    }
    const onScroll = () => {
      if (!touching && root.hasAttribute("data-keyboard") && window.scrollY !== 0) {
        window.scrollTo(0, 0)
      }
    }

    viewport.addEventListener("resize", settle)
    viewport.addEventListener("scroll", settle)
    window.addEventListener("scroll", onScroll, { passive: true })
    document.addEventListener("focusin", onFocusIn)
    document.addEventListener("focusout", onFocusOut)
    document.addEventListener("touchstart", onTouchStart, { passive: true })
    document.addEventListener("touchend", onTouchEnd, { passive: true })
    document.addEventListener("touchcancel", onTouchEnd, { passive: true })
    settle()
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(graceTimer)
      window.clearTimeout(closeTimer)
      viewport.removeEventListener("resize", settle)
      viewport.removeEventListener("scroll", settle)
      window.removeEventListener("scroll", onScroll)
      document.removeEventListener("focusin", onFocusIn)
      document.removeEventListener("focusout", onFocusOut)
      document.removeEventListener("touchstart", onTouchStart)
      document.removeEventListener("touchend", onTouchEnd)
      document.removeEventListener("touchcancel", onTouchEnd)
      root.style.removeProperty("--keyboard-inset")
      root.removeAttribute("data-keyboard")
    }
  }, [])

  return null
}

/** Scroll the focused field into view inside its own scroller, never by moving the document. */
function revealFocusedField() {
  const field = document.activeElement
  if (!isTextEntry(field)) return
  const scroller = scrollParent(field)
  if (!scroller) return
  const fieldRect = field.getBoundingClientRect()
  const frame = scroller.getBoundingClientRect()
  const bottom = Math.min(frame.bottom, window.visualViewport?.height ?? window.innerHeight) - 16
  const top = frame.top + 12
  if (fieldRect.bottom > bottom) {
    scroller.scrollBy({ top: fieldRect.bottom - bottom, behavior: "smooth" })
  } else if (fieldRect.top < top) {
    scroller.scrollBy({ top: fieldRect.top - top, behavior: "smooth" })
  }
}

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) {
      return node
    }
  }
  return null
}

function readKeyboards(): Record<string, number> {
  const stored: unknown = JSON.parse(localStorage.getItem(KEYBOARD_STORAGE_KEY) ?? "{}")
  if (typeof stored !== "object" || stored === null) return {}
  const heights: Record<string, number> = {}
  for (const [key, value] of Object.entries(stored)) {
    if (typeof value === "number") heights[key] = value
  }
  return heights
}

function expectedKeyboard(): number {
  try {
    const known = readKeyboards()[keyboardKey()]
    if (typeof known === "number" && known > KEYBOARD_THRESHOLD) return known
  } catch {
    // Storage may be unavailable; fall back to the typical proportion below.
  }
  // An iPhone keyboard with its suggestion bar covers a little under half the screen. Guessing
  // high only leaves a brief gap; guessing low lets iOS scroll the app.
  // iOS reports the screen in portrait whichever way it is held, so the window says which it is.
  const landscape = window.innerWidth > window.innerHeight
  const { width, height } = window.screen
  const tall = landscape ? Math.min(width, height) : Math.max(width, height)
  return Math.round(tall * (landscape ? 0.55 : 0.47))
}

function rememberKeyboard(height: number) {
  try {
    const stored = readKeyboards()
    // Keyboards differ by field (a search keyboard has no suggestion bar); keep the tallest.
    if ((stored[keyboardKey()] ?? 0) >= height) return
    stored[keyboardKey()] = height
    localStorage.setItem(KEYBOARD_STORAGE_KEY, JSON.stringify(stored))
  } catch {
    // Prediction simply starts from the estimate next time.
  }
}

// Keyboards differ by orientation and by browser chrome, both of which change the viewport width.
function keyboardKey(): string {
  return `${window.innerWidth}x${document.documentElement.clientHeight}`
}

function isIOS(): boolean {
  return (
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent))
  )
}

function hasTextFocus(): boolean {
  return opensKeyboard(document.activeElement)
}

// Selects open a picker rather than the keyboard.
function opensKeyboard(target: EventTarget | Element | null): target is HTMLElement {
  if (!isTextEntry(target) || target instanceof HTMLSelectElement) return false
  const field = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
  return !(field && target.readOnly)
}

const NON_TEXT_INPUTS = new Set([
  "checkbox",
  "radio",
  "range",
  "file",
  "color",
  "button",
  "submit",
  "reset",
  "image",
])

function isTextEntry(target: EventTarget | Element | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true
  if (target instanceof HTMLSelectElement) return true
  if (!(target instanceof HTMLInputElement)) return false
  return !NON_TEXT_INPUTS.has(target.type)
}
