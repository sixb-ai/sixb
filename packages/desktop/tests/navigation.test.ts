import { describe, expect, test } from "bun:test"
import {
  createNavigationState,
  isWebUrl,
  nextNavigationStep,
  type ShellConfig,
} from "../src/shell/navigation"
import { isAppUrl, mayNavigate } from "../src/shell/window"

const config: ShellConfig = {
  name: "Acme Orders",
  appUrl: "https://app.acme.test/",
  apiOrigin: "https://api.acme.test",
}

const signIn = "https://api.acme.test/auth/sign-in?returnTo=https%3A%2F%2Fapp.acme.test%2Forders"

describe("shell navigation", () => {
  test("turns the app's sign-in redirect into a request approved from the system browser", () => {
    const step = nextNavigationStep(config, createNavigationState(), signIn, 0)

    expect(step?.kind).toBe("load")
    const url = new URL(step?.url ?? "")
    expect(`${url.origin}${url.pathname}`).toBe("https://api.acme.test/auth/sign-in/device")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      returnTo: "https://app.acme.test/orders",
      client: "Acme Orders",
    })
  })

  test("answers one sign-in redirect once, however often it is reported", () => {
    const state = createNavigationState()

    expect(nextNavigationStep(config, state, signIn, 0)?.kind).toBe("load")
    expect(nextNavigationStep(config, state, signIn, 150)).toBeNull()
    // Signing out and back in later is a new redirect to the same address.
    expect(nextNavigationStep(config, state, signIn, 60_000)?.kind).toBe("load")
  })

  test("opens the approval page once per code while the waiting page reloads", () => {
    const state = createNavigationState()
    const waiting = "https://api.acme.test/auth/sign-in/device?user_code=BCDF-HJKM"

    expect(nextNavigationStep(config, state, waiting)).toEqual({
      kind: "open-external",
      url: "https://api.acme.test/auth/device?user_code=BCDF-HJKM",
    })
    expect(nextNavigationStep(config, state, waiting)).toBeNull()
    expect(
      nextNavigationStep(config, state, waiting.replace("BCDF-HJKM", "WXYZ-2345"))
    ).toMatchObject({ kind: "open-external" })
  })

  test("leaves every other navigation alone", () => {
    const state = createNavigationState()

    for (const url of [
      "https://app.acme.test/orders",
      "https://api.acme.test/auth/sign-in/device",
      "https://api.acme.test/auth/callback?token=abc",
      // Looks like the sign-in page, on an origin the shell was not built for.
      "https://evil.test/auth/sign-in",
      "file:///Applications/Acme.app/index.html",
      "not a url",
    ]) {
      expect(nextNavigationStep(config, state, url), url).toBeNull()
    }
  })

  test("keeps the window on the app and its API", () => {
    for (const url of [
      "https://app.acme.test/orders/42",
      "https://api.acme.test/auth/sign-in/device",
    ]) {
      expect(mayNavigate(config, url), url).toBe(true)
    }
    for (const url of [
      "https://docs.acme.test/guide",
      // Same host, different origin.
      "http://app.acme.test/orders",
      "https://app.acme.test.evil.test/",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(mayNavigate(config, url), url).toBe(false)
    }
  })

  test("grants device permissions to the app's own frames only", () => {
    expect(isAppUrl(config, "https://app.acme.test/orders")).toBe(true)
    // A map or chat widget the app embeds asks from its own origin.
    expect(isAppUrl(config, "https://maps.example.test/embed")).toBe(false)
    expect(isAppUrl(config, "https://api.acme.test/auth/sign-in/device")).toBe(false)
    // Before the first page commits there is no URL to judge.
    expect(isAppUrl(config, "")).toBe(false)
  })

  test("hands only web addresses to the system browser", () => {
    expect(isWebUrl("https://docs.acme.test/guide")).toBe(true)
    expect(isWebUrl("file:///etc/passwd")).toBe(false)
    expect(isWebUrl("slack://open")).toBe(false)
  })
})
