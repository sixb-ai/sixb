import { afterAll, afterEach, beforeAll } from "bun:test"
import { cleanup } from "@testing-library/react"
import { Window } from "happy-dom"

/**
 * A happy-dom window for every test in the file. Before the first test it puts `window`, `self`,
 * React's act flag, and each named global, read from the window, on `globalThis`; after each test
 * it unmounts what the test rendered; after the last it puts back what was there before.
 *
 * Each file names only the globals its components reach for: a global that is missing, such as
 * `matchMedia` or `ResizeObserver`, is itself behavior a component can depend on. `values` sets
 * globals the window does not have, such as a stubbed `IntersectionObserver`.
 */
export function installDom(
  globals: readonly string[],
  options: { readonly url?: string; readonly values?: Readonly<Record<string, unknown>> } = {}
): Window {
  const browser = new Window({ url: options.url ?? "https://app.sixb.test" })
  const window = browser as unknown as Record<string, unknown>
  const installed: Record<string, unknown> = {
    window: browser,
    self: browser,
    IS_REACT_ACT_ENVIRONMENT: true,
    ...Object.fromEntries(globals.map((key) => [key, window[key]])),
    ...options.values,
  }
  const previous = new Map<string, PropertyDescriptor | undefined>()

  beforeAll(() => {
    for (const [key, value] of Object.entries(installed)) {
      previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
    }
  })
  afterEach(() => cleanup())
  afterAll(async () => {
    // Work a last render scheduled can still reach for the DOM; let it run first.
    await Bun.sleep(0)
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    browser.close()
  })
  return browser
}
