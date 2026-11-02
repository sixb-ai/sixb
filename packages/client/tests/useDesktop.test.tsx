import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { cleanup, renderHook } from "@testing-library/react"
import { Window } from "happy-dom"
import { renderToString } from "react-dom/server"
import { useDesktop } from "../src/hooks"

const scope = globalThis as unknown as Record<string, unknown>
const previous = { window: scope.window, document: scope.document }

beforeAll(() => {
  const page = new Window()
  scope.window = page
  scope.document = page.document
})

afterEach(() => {
  cleanup()
  delete scope.sixbDesktop
})

afterAll(() => {
  scope.window = previous.window
  scope.document = previous.document
})

describe("useDesktop", () => {
  test("is null in a browser", () => {
    expect(renderHook(() => useDesktop()).result.current).toBeNull()
  })

  // Guard proof: copy the value in readDesktop; every render reads a new object, and React throws
  // that the store's snapshot keeps changing.
  test("is what the shell offers, the same one on every render", () => {
    const offered = { platform: "darwin" }
    scope.sixbDesktop = offered

    const hook = renderHook(() => useDesktop())
    expect(hook.result.current as unknown).toBe(offered)
    hook.rerender()
    expect(hook.result.current as unknown).toBe(offered)
  })

  // Guard proof: drop isSixbDesktop from readDesktop; a page's stray global reads as a desktop app.
  test.each([
    ["a platform it does not know", { platform: "plan9" }],
    ["no platform", {}],
    ["something else", "desktop"],
  ])("is null for %s", (_name, value) => {
    scope.sixbDesktop = value
    expect(renderHook(() => useDesktop()).result.current).toBeNull()
  })

  // Guard proof: pass readDesktop as useSyncExternalStore's server snapshot; a page the server
  // rendered without the shell then hydrates against one that differs.
  test("is null while rendering on a server", () => {
    scope.sixbDesktop = { platform: "darwin" }
    function Probe() {
      return <span>{useDesktop() === null ? "none" : "desktop"}</span>
    }
    expect(renderToString(<Probe />)).toContain("none")
  })
})
