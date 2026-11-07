import { useEffect, useLayoutEffect, useRef } from "react"

/**
 * The page never scales: inputs don't zoom on focus and Android resizes the layout for the
 * keyboard. Pinch-zoom stays available in the browser and is only switched off in the installed
 * app, where it would break the illusion of a native screen.
 */
const VIEWPORT =
  "width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover, interactive-widget=resizes-content"

// Below this the browser's own toolbars are moving, not a keyboard. An installed app has none, so
// there even the bar iOS shows above a hardware keyboard counts.
const KEYBOARD_THRESHOLD = 80
const STANDALONE_KEYBOARD_THRESHOLD = 30
// How the iOS keyboard rises, measured on iOS 26. `--keyboard-inset` follows on the same curve a
// couple of frames ahead (touch.css), and so does the scroll that keeps a field in view.
const KEYBOARD_RISE_MS = 450
const KEYBOARD_RISE = cubicBezier(0.2, 1, 0.25, 1)
const KEYBOARD_LEAD_MS = 33
// The tallest keyboard measured, per viewport size, so the page can rise with the keyboard before
// iOS reports its height.
const KEYBOARD_STORAGE_KEY = "sixb:keyboard-height"
// How long an expected keyboard may take to be reported before we assume none came, as with a
// hardware keyboard.
const KEYBOARD_GRACE_MS = 900
// A field that focuses itself, such as a chat composer after each answer, marks itself with
// `data-focus-on-tap`: its focus raises the keyboard only after a tap on it, within this long.
const TAP_FOCUSED = "[data-focus-on-tap]"
const TAP_FOCUS_MS = 1000
// What counts as a person acting on the page, for focus, and how long after it a focus may follow.
const INPUT_EVENTS = [
  "touchend",
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "keydown",
] as const
const ASK_WINDOW_MS = 1000
// A touch that moves less than this, and lifts sooner, is a tap.
const TAP_SLOP = 10
const TAP_MS = 500
// Input types that type text on the keyboard; the others open pickers.
const TYPED_INPUTS = new Set(["text", "search", "email", "url", "tel", "password", "number"])

/**
 * Keeps an app above the on-screen keyboard, the way a native app does: the screen stays put, the
 * keyboard slides over the bottom bar, and what sits at the bottom, a composer or a sheet, rides up
 * with it. Mount it once, at the root; it does nothing with a mouse.
 *
 * iOS overlays the keyboard and scrolls the whole document to reveal a field it will cover, which
 * slides the entire app off the top of the screen; undoing that scroll afterwards leaves the page
 * sliding back down into place under the keyboard. iOS leaves a focus that asks not to scroll
 * alone, so on iOS every focus asks, and a tapped field is focused that way as the touch lifts,
 * before the browser's own focus would. The app keeps the field in view itself.
 *
 * iOS holds the page's frames back while it brings the keyboard up and lets the next one through
 * with the keyboard's first, so the page starts to rise in that frame: `--keyboard-inset` takes the
 * height the keyboard had last time and animates to it on the keyboard's own curve, the shell
 * shrinking in step with it and the focused field scrolling clear of it as it arrives. iOS reports
 * the real height a few frames later, which corrects the rise if the keyboard differs.
 * `data-keyboard` on <html> marks the time the keyboard is up.
 *
 * Android resizes the layout itself (`interactive-widget=resizes-content`), so there the inset
 * stays zero and `data-keyboard` follows the focused field.
 *
 * iOS raises the keyboard only for a focus that happens while a tap or key press is being
 * handled. A field that focuses itself later, such as a form's first field once its screen has
 * rendered, would sit focused with no keyboard. So on a touch screen such a focus is turned away
 * and the field waits for a tap, as native fields do; while the keyboard is up, focus moves
 * freely. A field marked `data-focus-on-tap`, which focuses itself on arrival, counts only a tap
 * on itself in the last second as asking.
 */
export function TouchViewport() {
  // Whether the person asked for a focus on this field: the shared rule for the focus guard and
  // the keyboard prediction below.
  const asked = useRef<(field: HTMLElement) => boolean>(() => true)

  // A layout effect, so it already listens when the composer's autofocus runs on first render.
  useLayoutEffect(() => {
    if (!matchMedia("(pointer: coarse)").matches) return
    let tappedAt = Number.NEGATIVE_INFINITY
    const ios = isIOS()
    // The last tap or key press: what it touched, when, on which screen, and whether it is still
    // being handled (until the task that dispatched it ends).
    let input = {
      target: null as Element | null,
      at: Number.NEGATIVE_INFINITY,
      key: false,
      href: "",
      handling: false,
    }

    const markInput = (event: Event) => {
      const key = event.type === "keydown"
      input = {
        target: key
          ? document.activeElement
          : event.target instanceof Element
            ? event.target
            : null,
        at: performance.now(),
        key,
        href: window.location.href,
        handling: true,
      }
      const current = input
      window.setTimeout(() => (current.handling = false), 0)
    }

    // A focus is asked for when it lands on what was just tapped, inside it or on its label's
    // control, or when it comes while that tap is still being handled on the same screen, as a
    // sheet's first field or an inline editor's does. A new screen's field focusing itself is
    // not, however soon it renders.
    asked.current = (field) => {
      if (performance.now() - input.at > ASK_WINDOW_MS) return false
      if (input.key) return true
      const target = input.target
      if (target && (target === field || field.contains(target) || target.contains(field)))
        return true
      const label = target?.closest("label")
      if (label && (label.control === field || label.contains(field))) return true
      return input.handling && input.href === window.location.href
    }

    // The end of the touch too: a long press focuses the field only once it lifts.
    const onTouch = (event: TouchEvent) => {
      if (event.target instanceof Element && event.target.closest(TAP_FOCUSED))
        tappedAt = performance.now()
    }
    const unasked = (target: EventTarget | null): target is HTMLElement => {
      if (!opensKeyboard(target)) return false
      if (document.documentElement.hasAttribute("data-keyboard")) return false
      // Such a field waits for a tap on itself, even when it focuses while another tap is handled.
      if (target.closest(TAP_FOCUSED)) return performance.now() - tappedAt > TAP_FOCUS_MS
      return ios && !asked.current(target)
    }
    // Ahead of everything else, so neither the keyboard prediction nor the page sees the focus.
    const onFocusIn = (event: FocusEvent) => {
      if (!unasked(event.target)) return
      event.stopImmediatePropagation()
      event.target.blur()
    }

    for (const type of INPUT_EVENTS)
      window.addEventListener(type, markInput, { capture: true, passive: true })
    window.addEventListener("touchstart", onTouch, { capture: true, passive: true })
    window.addEventListener("touchend", onTouch, { capture: true, passive: true })
    window.addEventListener("focusin", onFocusIn, true)
    if (unasked(document.activeElement)) document.activeElement.blur()
    return () => {
      for (const type of INPUT_EVENTS)
        window.removeEventListener(type, markInput, { capture: true })
      window.removeEventListener("touchstart", onTouch, { capture: true })
      window.removeEventListener("touchend", onTouch, { capture: true })
      window.removeEventListener("focusin", onFocusIn, true)
      asked.current = () => true
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
    const standalone =
      matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    if (!standalone) return
    const prevent = (event: Event) => event.preventDefault()
    document.addEventListener("gesturestart", prevent)
    return () => document.removeEventListener("gesturestart", prevent)
  }, [])

  // iOS: every focus asks not to scroll, and a tapped field takes focus as the touch lifts.
  useEffect(() => {
    if (!isIOS() || !matchMedia("(pointer: coarse)").matches) return
    const prototype = HTMLElement.prototype
    const nativeFocus = prototype.focus
    prototype.focus = function focus(this: HTMLElement, options?: FocusOptions) {
      nativeFocus.call(this, { preventScroll: true, ...options })
    }

    let touch: { x: number; y: number; at: number } | null = null
    const onTouchStart = (event: TouchEvent) => {
      const point = event.touches[0]
      touch =
        event.touches.length === 1
          ? { x: point.clientX, y: point.clientY, at: event.timeStamp }
          : null
    }
    // After the tap is recorded (the effect above listens first), so the focus counts as asked.
    const onTouchEnd = (event: TouchEvent) => {
      const began = touch
      const point = event.changedTouches[0]
      touch = null
      if (!began || !point || event.touches.length > 0 || event.timeStamp - began.at > TAP_MS)
        return
      if (Math.hypot(point.clientX - began.x, point.clientY - began.y) > TAP_SLOP) return
      const field = tappedField(event.target)
      // The browser's click still follows and places the caret where the finger landed.
      if (field && field !== document.activeElement) field.focus()
    }

    window.addEventListener("touchstart", onTouchStart, { capture: true, passive: true })
    window.addEventListener("touchend", onTouchEnd, { capture: true, passive: true })
    return () => {
      prototype.focus = nativeFocus
      window.removeEventListener("touchstart", onTouchStart, { capture: true })
      window.removeEventListener("touchend", onTouchEnd, { capture: true })
    }
  }, [])

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport || !matchMedia("(pointer: coarse)").matches) return
    const root = document.documentElement
    const ios = isIOS()
    const threshold = isStandalone() ? STANDALONE_KEYBOARD_THRESHOLD : KEYBOARD_THRESHOLD
    let inset = 0
    let expectedAt = 0
    let touching = false
    let riseFrame = 0
    let closeTimer = 0
    let graceTimer = 0
    let stopReveal = () => {}

    const setInset = (px: number) => {
      if (px === inset) return
      inset = px
      root.style.setProperty("--keyboard-inset", `${px}px`)
    }
    const setOpen = (open: boolean) => root.toggleAttribute("data-keyboard", open)
    const reveal = (rising: boolean) => {
      stopReveal()
      stopReveal = revealFocusedField(() => appHeight() - inset, rising)
    }
    const close = () => {
      expectedAt = 0
      cancelAnimationFrame(riseFrame)
      window.clearTimeout(graceTimer)
      stopReveal()
      setInset(0)
      setOpen(false)
    }

    // iOS 26 shrinks innerHeight along with the visual viewport; the app's own height does not move.
    const measured = () => {
      const covered = Math.round(appHeight() - viewport.height * viewport.scale)
      return covered > threshold ? covered : 0
    }

    // The keyboard is on its way. The next frame iOS lets through is the keyboard's first.
    const expectKeyboard = () => {
      window.clearTimeout(closeTimer)
      cancelAnimationFrame(riseFrame)
      riseFrame = requestAnimationFrame(() => {
        if (!hasTextFocus() || measured() > 0) return
        expectedAt = performance.now()
        setInset(expectedKeyboard())
        setOpen(true)
        reveal(true)
        window.clearTimeout(graceTimer)
        graceTimer = window.setTimeout(() => {
          if (measured() === 0) close()
        }, KEYBOARD_GRACE_MS)
      })
    }

    // The keyboard's real height, a few frames into its rise, or its leaving.
    const onViewportChange = () => {
      if (!ios) return
      // Only a focused field brings a keyboard. An installed app can open with the visible area a
      // status bar short of the screen, which would otherwise read as a keyboard.
      const keyboard = hasTextFocus() ? measured() : 0
      if (keyboard > 0) {
        expectedAt = 0
        cancelAnimationFrame(riseFrame)
        window.clearTimeout(graceTimer)
        rememberKeyboard(keyboard)
        const changed = keyboard !== inset
        setInset(keyboard)
        setOpen(true)
        if (!touching && window.scrollY !== 0) window.scrollTo(0, 0)
        if (changed) reveal(true)
      } else if (expectedAt && performance.now() - expectedAt < KEYBOARD_GRACE_MS) {
        // Still on its way.
      } else if (inset > 0 || root.hasAttribute("data-keyboard")) {
        // Gone, even if the field kept focus (Done can hide the keyboard without blurring).
        close()
      }
    }

    const onFocusIn = (event: FocusEvent) => {
      if (!opensKeyboard(event.target)) return
      window.clearTimeout(closeTimer)
      // Moving to another field while the keyboard is up: bring it clear of the keyboard.
      if (root.hasAttribute("data-keyboard")) requestAnimationFrame(() => reveal(false))
      else if (!ios) setOpen(true)
      // Only a focus given during a tap or key press brings a keyboard.
      else if (asked.current(event.target)) expectKeyboard()
    }

    // Moving between fields blurs one before focusing the next; only a real dismissal closes.
    const onFocusOut = () => {
      window.clearTimeout(closeTimer)
      closeTimer = window.setTimeout(() => {
        if (hasTextFocus()) return
        if (!ios) setOpen(false)
        else if (measured() === 0) close()
      }, 120)
    }

    // With the keyboard up iOS lets the whole document be dragged; it springs back on release.
    const onTouchStart = () => {
      touching = true
      stopReveal()
    }
    const onTouchEnd = (event: TouchEvent) => {
      touching = false
      if (root.hasAttribute("data-keyboard")) {
        if (window.scrollY !== 0) window.scrollTo(0, 0)
        return
      }
      // A tap on a field that kept focus after the keyboard left brings it back, with no focus.
      const field =
        event.target instanceof Element
          ? event.target.closest("input, textarea, [contenteditable]")
          : null
      if (ios && field && field === document.activeElement && opensKeyboard(field)) expectKeyboard()
    }
    const onScroll = () => {
      if (!touching && root.hasAttribute("data-keyboard") && window.scrollY !== 0) {
        window.scrollTo(0, 0)
      }
    }

    viewport.addEventListener("resize", onViewportChange)
    viewport.addEventListener("scroll", onViewportChange)
    window.addEventListener("scroll", onScroll, { passive: true })
    document.addEventListener("focusin", onFocusIn)
    document.addEventListener("focusout", onFocusOut)
    document.addEventListener("touchstart", onTouchStart, { passive: true })
    document.addEventListener("touchend", onTouchEnd, { passive: true })
    document.addEventListener("touchcancel", onTouchEnd, { passive: true })
    onViewportChange()
    return () => {
      close()
      window.clearTimeout(closeTimer)
      viewport.removeEventListener("resize", onViewportChange)
      viewport.removeEventListener("scroll", onViewportChange)
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

// Overlays that ride the keyboard on their own, and may still be rising into place as it opens. A
// panel that rests on the keyboard without being a dialog marks itself `data-keyboard-overlay`.
const RIDING_OVERLAY =
  '[role="dialog"], [role="alertdialog"], [data-vaul-drawer], [data-keyboard-overlay]'

/**
 * Scrolls the focused field clear of the keyboard inside its own scroller, never by moving the
 * document. While the keyboard rises, a field on the page travels with it, so it arrives as the
 * keyboard does; a field in a sheet waits for the sheet to arrive above the keyboard, since until
 * then where it sits says nothing about where it will be. Returns a stop, for a touch that takes
 * over.
 */
function revealFocusedField(keyboardTop: () => number, rising: boolean): () => void {
  const field = document.activeElement
  const scroller = isTextEntry(field) ? scrollParent(field) : null
  if (!field || !scroller) return () => {}
  let stopped = false
  let frameId = 0
  let timer = 0

  const scroll = (lead: number) => {
    const fieldRect = field.getBoundingClientRect()
    const frame = scroller.getBoundingClientRect()
    const bottom = Math.min(frame.bottom, keyboardTop()) - 16
    const top = frame.top + 12
    const distance =
      fieldRect.bottom > bottom
        ? fieldRect.bottom - bottom
        : fieldRect.top < top
          ? fieldRect.top - top
          : 0
    if (Math.abs(distance) < 1) return
    // Set frame by frame: a shrinking scroller doesn't have its final scroll range yet. The first
    // step goes out with the frame that starts the rise, ahead of the frames iOS holds back next.
    const from = scroller.scrollTop
    const started = performance.now() - lead
    const step = (now: number) => {
      const progress = Math.min(1, (now - started) / KEYBOARD_RISE_MS)
      scroller.scrollTop = from + distance * KEYBOARD_RISE(progress)
      if (progress < 1 && !stopped) frameId = requestAnimationFrame(step)
    }
    step(performance.now())
  }

  const overlay = scroller.closest(RIDING_OVERLAY)
  if (!rising) scroll(0)
  else if (!overlay) scroll(KEYBOARD_LEAD_MS)
  else {
    timer = window.setTimeout(async () => {
      await Promise.allSettled(overlay.getAnimations().map((animation) => animation.finished))
      if (!stopped) scroll(0)
    }, KEYBOARD_RISE_MS - KEYBOARD_LEAD_MS)
  }
  return () => {
    stopped = true
    window.clearTimeout(timer)
    cancelAnimationFrame(frameId)
  }
}

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight)
      return node
  }
  return null
}

/** The text field a tap lands on, directly or through its label; a rich editor's editing host. */
function tappedField(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const label = target.closest("label")?.control ?? null
  const field =
    target.closest<HTMLElement>("input, textarea, [contenteditable]") ??
    (label as HTMLElement | null)
  if (!field || !typesText(field)) return null
  let host = field
  while (host.isContentEditable && host.parentElement?.isContentEditable) host = host.parentElement
  return host
}

function typesText(field: HTMLElement): boolean {
  if (field.isContentEditable) return true
  if (field instanceof HTMLTextAreaElement) return !field.disabled && !field.readOnly
  return (
    field instanceof HTMLInputElement &&
    TYPED_INPUTS.has(field.type) &&
    !field.disabled &&
    !field.readOnly
  )
}

/** A CSS cubic-bezier timing function, for motion that must match one. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (progress: number) => number {
  const at = (a: number, b: number, t: number) =>
    3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t
  return (progress) => {
    if (progress <= 0) return 0
    if (progress >= 1) return 1
    let low = 0
    let high = 1
    for (let step = 0; step < 24; step++) {
      const middle = (low + high) / 2
      if (at(x1, x2, middle) < progress) low = middle
      else high = middle
    }
    return at(y1, y2, (low + high) / 2)
  }
}

function expectedKeyboard(): number {
  try {
    const stored = JSON.parse(localStorage.getItem(KEYBOARD_STORAGE_KEY) ?? "{}") as Record<
      string,
      number
    >
    const known = stored[keyboardKey()]
    if (typeof known === "number" && known > KEYBOARD_THRESHOLD) return known
  } catch {
    // Storage may be unavailable; fall back to the typical proportion below.
  }
  // An iPhone keyboard with its suggestion bar covers a little under half the screen.
  return Math.round(
    window.screen.height * (window.screen.width > window.screen.height ? 0.55 : 0.47)
  )
}

function rememberKeyboard(height: number) {
  try {
    const stored = JSON.parse(localStorage.getItem(KEYBOARD_STORAGE_KEY) ?? "{}") as Record<
      string,
      number
    >
    // Keyboards differ by field (a number pad is shorter); keep the tallest.
    if ((stored[keyboardKey()] ?? 0) >= height) return
    stored[keyboardKey()] = height
    localStorage.setItem(KEYBOARD_STORAGE_KEY, JSON.stringify(stored))
  } catch {
    // The rise simply starts from the estimate next time.
  }
}

// Keyboards differ by orientation and by browser chrome, both of which change the viewport width.
function keyboardKey(): string {
  return `${window.innerWidth}x${document.documentElement.clientHeight}`
}

let viewportProbe: HTMLElement | null = null

/**
 * The height the app is laid out in, from the top of the screen: `--viewport-height` (touch.css).
 * In an installed app iOS reports some measures a status bar off, so the keyboard is measured
 * against what the app is actually sized by; measured against a short one, it would come out short
 * by as much and leave whatever rides on it partly covered.
 */
function appHeight(): number {
  if (!viewportProbe) {
    viewportProbe = document.createElement("div")
    viewportProbe.setAttribute("aria-hidden", "true")
    viewportProbe.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:var(--viewport-height,100dvh);visibility:hidden;pointer-events:none"
  }
  if (!viewportProbe.isConnected) document.body.append(viewportProbe)
  return viewportProbe.offsetHeight
}

function isStandalone(): boolean {
  return (
    matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
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
  return (
    isTextEntry(target) &&
    !(target instanceof HTMLSelectElement) &&
    !(target as HTMLInputElement).readOnly
  )
}

function isTextEntry(target: EventTarget | Element | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true
  if (target instanceof HTMLSelectElement) return true
  if (!(target instanceof HTMLInputElement)) return false
  return ![
    "checkbox",
    "radio",
    "range",
    "file",
    "color",
    "button",
    "submit",
    "reset",
    "image",
  ].includes(target.type)
}
