import { afterEach, describe, expect, jest, test } from "bun:test"
import type { ShellConfig } from "../src/shell/navigation"
import { keepUpToDate, UPDATE_INTERVAL_MS, type Updater } from "../src/shell/updates"

const config: ShellConfig = {
  name: "Acme Orders",
  appUrl: "https://app.acme.test/orders",
  apiOrigin: "https://api.acme.test",
}

/** Electron's updater as far as the shell uses it, recording what it's asked. */
function fakeUpdater(options: { readonly unsigned?: boolean } = {}) {
  const feeds: unknown[] = []
  const listeners: Record<string, (error?: Error) => void> = {}
  let checks = 0
  const updater: Updater = {
    setFeedURL: (feed) => {
      if (options.unsigned) throw new Error("Could not get code signature for running application")
      feeds.push(feed)
    },
    checkForUpdates: () => {
      checks++
    },
    on: (event: string, listener: (error: Error) => void) => {
      listeners[event] = listener as (error?: Error) => void
    },
  }
  return { updater, feeds, listeners, checks: () => checks }
}

afterEach(() => {
  jest.useRealTimers()
})

describe("updates", () => {
  test("reads the deployment's feed at launch, then every few hours", () => {
    jest.useFakeTimers()
    const fake = fakeUpdater()

    keepUpToDate(config, fake.updater)

    expect(fake.feeds).toEqual([
      { url: "https://app.acme.test/__sixb/desktop/darwin/releases.json", serverType: "json" },
    ])
    expect(fake.checks()).toBe(1)
    jest.advanceTimersByTime(UPDATE_INTERVAL_MS)
    expect(fake.checks()).toBe(2)
  })

  // Guard check: drop the `update-downloaded` listener, and the next interval checks again.
  test("stops checking once a new version is downloaded, which would fetch it again", () => {
    jest.useFakeTimers()
    const fake = fakeUpdater()

    keepUpToDate(config, fake.updater)
    fake.listeners["update-downloaded"]?.()
    jest.advanceTimersByTime(UPDATE_INTERVAL_MS * 3)

    expect(fake.checks()).toBe(1)
  })

  test("leaves an app macOS won't let update, signed ad hoc, as it is", () => {
    jest.useFakeTimers()
    const fake = fakeUpdater({ unsigned: true })
    const error = jest.spyOn(console, "error").mockImplementation(() => {})

    try {
      keepUpToDate(config, fake.updater)
      jest.advanceTimersByTime(UPDATE_INTERVAL_MS)
    } finally {
      error.mockRestore()
    }

    expect(fake.checks()).toBe(0)
  })
})
