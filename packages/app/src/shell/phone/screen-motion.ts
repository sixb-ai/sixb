import {
  appScroller,
  historyIndex,
  isRootPath,
  normalizePath,
  PHONE_QUERY,
  sectionOf,
} from "./routes"

/*
 * Native screen transitions on a phone.
 *
 * React swaps a page's content in place, so the screen being left is gone before anything can
 * move. Native navigation keeps both on screen: a pushed screen slides in over the current one,
 * which drifts left and dims; Back does the reverse. So the moment the router changes the URL,
 * before React renders the next page, the current screen is copied into an inert "ghost" laid
 * exactly over it. Once the next page has rendered, the two move together and the ghost is
 * dropped.
 *
 * The back swipe is iOS's own in the installed app, as in Safari: it animates the change itself, so
 * a Back it drives is not animated again.
 */

type ScreenMotion = "push" | "pop"

const DURATION_MS = 480
const EASING = "cubic-bezier(0.32, 0.72, 0, 1)"
// How far the screen underneath sits to the left, as a share of the width.
const PARALLAX = 0.3
// A copy larger than this costs more than the transition is worth.
const MAX_NODES = 6000

interface Pending {
  readonly motion: ScreenMotion
  readonly ghost: HTMLElement
  // The address it was copied for; a different one committing means it no longer applies.
  readonly to: string
}

let pending: Pending | null = null
let lastPath = "/"
let lastIndex = 0
let stopCurrent: (() => void) | null = null
let copies = 0

/**
 * Watch the router's history calls so the screen can be copied before React replaces it.
 * Returns the function that stops watching.
 */
export function watchScreenChanges(): () => void {
  lastPath = normalizePath(window.location.pathname)
  lastIndex = historyIndex()
  const history = window.history
  const pushState = history.pushState
  const replaceState = history.replaceState

  // Going up to a screen above, such as a tab's first screen or a record after saving its form,
  // moves back the way Back does, even when it is a new history entry.
  history.pushState = function (this: History, ...args: Parameters<History["pushState"]>) {
    const to = targetPath(args[2])
    prepare(to, goesUp(lastPath, to) ? "pop" : "push")
    pushState.apply(this, args)
  }
  history.replaceState = function (this: History, ...args: Parameters<History["replaceState"]>) {
    const to = targetPath(args[2])
    if (to !== lastPath && goesUp(lastPath, to)) prepare(to, "pop")
    replaceState.apply(this, args)
  }

  // Capturing, so the copy is taken before the router reacts to Back. A Back the system animated
  // itself, as iOS's back swipe does, is not animated again.
  const onPopState = (event: PopStateEvent) => {
    if (event.hasUAVisualTransition) {
      clearPending()
      return
    }
    const index = historyIndex()
    prepare(normalizePath(window.location.pathname), index < lastIndex ? "pop" : "push")
  }
  window.addEventListener("popstate", onPopState, true)

  return () => {
    history.pushState = pushState
    history.replaceState = replaceState
    window.removeEventListener("popstate", onPopState, true)
    // A screen without the shell, such as a print view, unmounts this; nothing carries over.
    settleScreenMotion()
    clearPending()
  }
}

/**
 * Called once the next page has rendered, before the browser paints it: moves the screens.
 */
export function runScreenMotion(pathname: string): void {
  const to = normalizePath(pathname)
  lastPath = to
  lastIndex = historyIndex()

  const current = pending
  pending = null
  if (!current) return
  const scroller = appScroller()
  if (current.to !== to || !scroller || !scroller.parentElement) {
    current.ghost.remove()
    return
  }

  slide(scroller, current.ghost, current.motion, () => current.ghost.remove())
}

/**
 * Lay a screen copy under or over the page scroller, at the scroller's own scroll position, with
 * the dimming layer between them.
 */
function mountGhost(
  ghost: HTMLElement,
  scroller: HTMLElement,
  place: "under" | "over"
): { readonly dim: HTMLElement; readonly remove: () => void } {
  const parent = scroller.parentElement as HTMLElement
  const dim = document.createElement("div")
  dim.className = "screen-dim"
  dim.setAttribute("aria-hidden", "true")
  scroller.dataset.screenMoving = place === "under" ? "over" : "under"
  parent.append(dim)
  ghost.dataset.place = place
  parent.append(ghost)
  ghost.scrollTop = Number(ghost.dataset.scrollTop ?? 0)
  return {
    dim,
    remove: () => {
      dim.remove()
      ghost.remove()
      delete scroller.dataset.screenMoving
    },
  }
}

/** End any transition still running, leaving the current screen in place. */
function settleScreenMotion(): void {
  stopCurrent?.()
  stopCurrent = null
}

function clearPending() {
  pending?.ghost.remove()
  pending = null
}

function prepare(to: string, motion: ScreenMotion) {
  settleScreenMotion()
  clearPending()
  if (!movesScreen(lastPath, to)) return
  const scroller = appScroller()
  if (!scroller || !scroller.parentElement) return
  const ghost = copyScreen(scroller)
  if (!ghost) return
  pending = { motion, ghost, to }
}

/**
 * Screens within a section push and pop. Moving between sections, or between top-level screens,
 * swaps in place, as switching tabs does natively.
 */
function movesScreen(from: string, to: string): boolean {
  if (from === to) return false
  if (!window.matchMedia(PHONE_QUERY).matches) return false
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false
  if (sectionOf(from) !== sectionOf(to)) return false
  if (isRootPath(from) && isRootPath(to)) return false
  return true
}

/** Whether `to` sits above `from`: a top-level screen, or a parent address. */
function goesUp(from: string, to: string): boolean {
  return (isRootPath(to) && !isRootPath(from)) || from.startsWith(`${to === "/" ? "" : to}/`)
}

function copyScreen(scroller: HTMLElement): HTMLElement | null {
  if (scroller.getElementsByTagName("*").length > MAX_NODES) return null
  const ghost = scroller.cloneNode(true) as HTMLElement
  // Keeps the scroller's own styles; lookups find the real scroller first, as it comes first.
  ghost.dataset.appScroll = "ghost"
  ghost.removeAttribute("data-screen-moving")
  const style = getComputedStyle(scroller)
  ghost.style.paddingTop = style.paddingTop
  ghost.style.paddingBottom = style.paddingBottom
  ghost.removeAttribute("id")
  ghost.classList.add("screen-ghost")
  ghost.setAttribute("aria-hidden", "true")
  ghost.inert = true
  ghost.dataset.scrollTop = String(scroller.scrollTop)

  // Copies of frames and media would load again; a canvas copies blank, so paint it in.
  for (const media of ghost.querySelectorAll("iframe, video, audio, object, embed")) {
    const stand = document.createElement("div")
    stand.className = (media as HTMLElement).className
    stand.style.cssText = (media as HTMLElement).style.cssText
    media.replaceWith(stand)
  }
  const sources = scroller.querySelectorAll("canvas")
  ghost.querySelectorAll("canvas").forEach((canvas, index) => {
    const source = sources[index]
    if (!source || source.width === 0 || source.height === 0) return
    try {
      canvas.getContext("2d")?.drawImage(source, 0, 0)
    } catch {
      // A tainted or WebGL canvas stays blank in the copy.
    }
  })
  renameIds(ghost)
  return ghost
}

/**
 * Ids must stay unique on the page, so the copy's get a suffix, and what points at them inside
 * it, such as a chart's gradient fill, follows.
 */
function renameIds(ghost: HTMLElement) {
  const suffix = `-screen-${++copies}`
  const renamed = new Set<string>()
  for (const element of ghost.querySelectorAll("[id]")) {
    renamed.add(element.id)
    element.id += suffix
  }
  if (!renamed.size) return
  const reference = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g
  const follow = (value: string) =>
    value.replace(reference, (match, quote: string, id: string) =>
      renamed.has(id) ? `url(${quote}#${id}${suffix}${quote})` : match
    )
  for (const element of ghost.querySelectorAll("*")) {
    for (const { name, value } of [...element.attributes]) {
      if (value.includes("url(")) {
        element.setAttribute(name, follow(value))
      } else if (
        (name === "href" || name === "xlink:href") &&
        value.startsWith("#") &&
        renamed.has(value.slice(1))
      ) {
        element.setAttribute(name, `${value}${suffix}`)
      }
    }
  }
}

function slide(scroller: HTMLElement, ghost: HTMLElement, motion: ScreenMotion, done: () => void) {
  const width = scroller.offsetWidth
  const { dim, remove } = mountGhost(ghost, scroller, motion === "push" ? "under" : "over")
  const timing: KeyframeAnimationOptions = { duration: DURATION_MS, easing: EASING }
  const away = `translate3d(${-width * PARALLAX}px, 0, 0)`
  const off = `translate3d(${width}px, 0, 0)`
  const still = "translate3d(0, 0, 0)"

  const animations =
    motion === "push"
      ? [
          scroller.animate({ transform: [off, still] }, timing),
          ghost.animate({ transform: [still, away] }, timing),
          dim.animate({ opacity: [0, 1] }, timing),
        ]
      : [
          scroller.animate({ transform: [away, still] }, timing),
          ghost.animate({ transform: [still, off] }, timing),
          dim.animate({ opacity: [1, 0] }, timing),
        ]

  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    for (const animation of animations) animation.cancel()
    remove()
    done()
  }
  void Promise.all(animations.map((animation) => animation.finished)).then(finish, finish)
  // A new navigation mid-flight ends this one at once.
  stopCurrent = finish
}

function targetPath(url: string | URL | null | undefined): string {
  if (url == null) return lastPath
  try {
    return normalizePath(new URL(String(url), window.location.href).pathname)
  } catch {
    return lastPath
  }
}
