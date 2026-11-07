import { useEffect } from "react"

const PHONE_QUERY = "(max-width: 767px)"
// A dialog marked `data-fullscreen` fills a phone's screen rather than rising as a sheet.
const SHEETS =
  '[data-slot="dialog-content"]:not([data-fullscreen]), [data-slot="alert-dialog-content"]'
const OVERLAYS = '[data-slot="dialog-overlay"], [data-slot="alert-dialog-overlay"]'
// Controls that own vertical drags themselves.
const OWN_DRAG = 'input, textarea, select, [contenteditable="true"], [role="slider"]'

/**
 * On phones every dialog presents as a sheet from the bottom of the screen (touch.css). This lets
 * each one be pulled down to dismiss, as native sheets are: the sheet follows the finger
 * once its content is scrolled to the top, and a long or quick pull closes it the way Escape
 * would, so a dialog that refuses Escape simply springs back.
 */
export function SheetGestures() {
  useEffect(() => {
    const phone = matchMedia(PHONE_QUERY)
    let sheet: HTMLElement | null = null
    let overlay: HTMLElement | null = null
    let startY = 0
    let startX = 0
    let offset = 0
    let dragging = false
    let lastY = 0
    let lastTime = 0
    let velocity = 0

    const reset = () => {
      sheet = null
      overlay = null
      dragging = false
      offset = 0
      velocity = 0
    }

    const onStart = (event: TouchEvent) => {
      if (!phone.matches || event.touches.length !== 1) return
      const target = event.target instanceof Element ? event.target : null
      const found = target?.closest<HTMLElement>(SHEETS)
      if (!target || !found) return
      if (target.closest(OWN_DRAG) || scrolledWithin(target, found)) return
      const touch = event.touches[0]
      sheet = found
      overlay = [...document.querySelectorAll<HTMLElement>(OVERLAYS)].at(-1) ?? null
      startY = lastY = touch.clientY
      startX = touch.clientX
      lastTime = event.timeStamp
    }

    const onMove = (event: TouchEvent) => {
      if (!sheet) return
      const touch = event.touches[0]
      const dy = touch.clientY - startY
      if (!dragging) {
        // Sideways or upward movement belongs to the content.
        if (Math.abs(touch.clientX - startX) > Math.abs(dy) || dy < -4) return reset()
        if (dy < 6) return
        dragging = true
        sheet.style.transition = "none"
        if (overlay) overlay.style.transition = "none"
      }
      event.preventDefault()
      offset = Math.max(0, dy - 6)
      velocity = (touch.clientY - lastY) / Math.max(1, event.timeStamp - lastTime)
      lastY = touch.clientY
      lastTime = event.timeStamp
      sheet.style.transform = `translate3d(0, ${offset}px, 0)`
      if (overlay) overlay.style.opacity = String(Math.max(0, 1 - offset / sheet.offsetHeight))
    }

    const onEnd = () => {
      if (!sheet || !dragging) return reset()
      const current = sheet
      const currentOverlay = overlay
      const dismiss = offset > current.offsetHeight * 0.28 || velocity > 0.55
      const settle = "transform 320ms cubic-bezier(0.32, 0.72, 0, 1), opacity 320ms ease"
      current.style.transition = settle
      if (currentOverlay) currentOverlay.style.transition = settle

      if (dismiss) {
        current.style.transform = "translate3d(0, 100%, 0)"
        if (currentOverlay) currentOverlay.style.opacity = "0"
        current.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
        // Still open: the dialog guards against dismissal, so it returns.
        window.setTimeout(() => {
          if (current.isConnected && current.dataset.state !== "closed") {
            springBack(current, currentOverlay)
          }
        }, 120)
      } else {
        springBack(current, currentOverlay)
      }
      reset()
    }

    document.addEventListener("touchstart", onStart, { passive: true })
    document.addEventListener("touchmove", onMove, { passive: false })
    document.addEventListener("touchend", onEnd)
    document.addEventListener("touchcancel", onEnd)
    return () => {
      document.removeEventListener("touchstart", onStart)
      document.removeEventListener("touchmove", onMove)
      document.removeEventListener("touchend", onEnd)
      document.removeEventListener("touchcancel", onEnd)
    }
  }, [])

  return null
}

function springBack(sheet: HTMLElement, overlay: HTMLElement | null) {
  sheet.style.transform = ""
  if (overlay) overlay.style.opacity = ""
  // A child's transition bubbles up too; only the sheet's own spring finishing counts.
  const finish = (event: TransitionEvent) => {
    if (event.target !== sheet) return
    sheet.removeEventListener("transitionend", finish)
    sheet.style.transition = ""
    if (overlay) overlay.style.transition = ""
  }
  sheet.addEventListener("transitionend", finish)
}

/** Whether anything from `target` up to `container` is scrolled away from its top. */
function scrolledWithin(target: Element, container: HTMLElement): boolean {
  for (let node: Element | null = target; node; node = node.parentElement) {
    if (node.scrollTop > 0) return true
    if (node === container) return false
  }
  return false
}
