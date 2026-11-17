import { act } from "@testing-library/react"

type Width = (element: HTMLElement) => number

/**
 * Lays out what Happy DOM doesn't. Each element reports, through `clientWidth` and
 * `getBoundingClientRect()`, the width of the first rule whose selector it matches, and 0 once
 * detached, as a browser does.
 *
 * `resize()` plays the browser's layout pass: it notifies the ResizeObservers watching an element
 * whose width changed since they last looked, runs the frames they request, and repeats until
 * nothing changes. `restore()` puts Happy DOM back.
 */
export function fakeLayout(rules: Readonly<Record<string, Width>>) {
  const widthOf = (element: Element): number => {
    if (!element.isConnected) return 0

    for (const [selector, width] of Object.entries(rules)) {
      if (element.matches(selector)) return width(element as HTMLElement)
    }
    return 0
  }

  const observers = new Set<FakeResizeObserver>()

  class FakeResizeObserver {
    readonly seen = new Map<Element, number>()

    constructor(readonly callback: ResizeObserverCallback) {}

    observe(target: Element) {
      this.seen.set(target, widthOf(target))
      observers.add(this)
    }

    unobserve(target: Element) {
      this.seen.delete(target)
    }

    disconnect() {
      this.seen.clear()
      observers.delete(this)
    }
  }

  // Each observer watching an element whose width changed is called once; false when none is.
  const notify = (): boolean => {
    let notified = false

    for (const observer of [...observers]) {
      const changed = [...observer.seen].filter(([target, width]) => widthOf(target) !== width)
      if (changed.length === 0) continue

      for (const [target] of changed) observer.seen.set(target, widthOf(target))
      observer.callback([], observer as unknown as ResizeObserver)
      notified = true
    }

    return notified
  }

  const resize = () => {
    const frames: FrameRequestCallback[] = []
    const requestFrame = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = (frame) => frames.push(frame)

    try {
      for (let pass = 0; pass < 10; pass++) {
        let notified = false
        act(() => {
          notified = notify()
          for (const frame of frames.splice(0)) frame(0)
        })
        if (!notified) return
      }
      throw new Error("[test] The layout never settles: each pass changes a width again.")
    } finally {
      globalThis.requestAnimationFrame = requestFrame
    }
  }

  const prototype = HTMLElement.prototype
  const ResizeObserverBefore = globalThis.ResizeObserver

  Object.defineProperty(prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return widthOf(this)
    },
  })
  Object.defineProperty(prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      return { width: widthOf(this) } as DOMRect
    },
  })
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver

  const restore = () => {
    Reflect.deleteProperty(prototype, "clientWidth")
    Reflect.deleteProperty(prototype, "getBoundingClientRect")
    globalThis.ResizeObserver = ResizeObserverBefore
  }

  return { resize, restore }
}

/**
 * The composer in a phone's 390px row. Its text is 9px a character plus 16px of padding; it has
 * `room()` beside the controls, and 340px on a row of its own. An empty field dictation hides is
 * 0 wide, like the spacer while the text shares the row.
 */
export function composerLayout(room: () => number) {
  const expanded = (element: Element) =>
    element.closest(".sixb-composer-surface")?.hasAttribute("data-expanded") ?? false

  const longestLine = (sizer: Element) =>
    Math.max(...[...sizer.children].map((line) => line.textContent?.length ?? 0))

  return fakeLayout({
    "[data-composer-sizer]": (sizer) => 16 + 9 * longestLine(sizer),
    "[data-composer-spacer]": (spacer) => (expanded(spacer) ? room() : 0),
    textarea: (field) => {
      if (field.classList.contains("hidden")) return 0
      return expanded(field) ? 340 : room()
    },
    "*": () => 390,
  })
}
