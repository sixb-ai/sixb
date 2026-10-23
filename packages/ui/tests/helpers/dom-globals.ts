import { Window } from "happy-dom"

/**
 * Installs a happy-dom window on `globalThis` when imported. Import it before any React or Radix
 * module: both decide at load time whether a DOM exists, and Radix never opens a popover when it
 * loaded without one.
 */
const browser = new Window({ url: "https://ui.sixb.test" })
const window = browser as unknown as Record<string, unknown>

const globals = [
  "document",
  "navigator",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "CustomEvent",
  "FocusEvent",
  "InputEvent",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "EventTarget",
  "MutationObserver",
  "ResizeObserver",
  "DOMRect",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
]

Object.assign(globalThis, {
  window: browser,
  self: browser,
  IS_REACT_ACT_ENVIRONMENT: true,
  ...Object.fromEntries(globals.map((key) => [key, window[key]])),
})
