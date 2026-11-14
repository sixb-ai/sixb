import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { SandboxRecovery } from "../src/agent/components/sandbox-recovery"

test("offers explicit workspace recreation without performing it during render", () => {
  let calls = 0
  const html = renderToStaticMarkup(
    createElement(SandboxRecovery, {
      pending: false,
      error: false,
      canRecreate: true,
      owner: "Alice Martin",
      onRecreate: () => {
        calls++
      },
    })
  )
  expect(html).toContain("Sandbox recovery required")
  expect(html).toContain("Start with a fresh sandbox")
  expect(html).toContain("Automatic resume is blocked")
  expect(calls).toBe(0)
})

test("disables duplicate recovery requests and exposes failures", () => {
  const html = renderToStaticMarkup(
    createElement(SandboxRecovery, {
      pending: true,
      error: true,
      canRecreate: true,
      owner: "Alice Martin",
      onRecreate: () => {},
    })
  )
  expect(html).toContain("disabled")
  expect(html).toContain('role="alert"')
  expect(html).toContain("Could not recreate")
})

test("offers to resume a prepared workspace beside starting fresh, without resuming during render", () => {
  let restores = 0
  const html = renderToStaticMarkup(
    createElement(SandboxRecovery, {
      pending: false,
      error: false,
      canRecreate: true,
      owner: "Alice Martin",
      onRecreate: () => {},
      restore: {
        pending: false,
        error: false,
        onRestore: () => {
          restores++
        },
      },
    })
  )
  expect(html).toContain("Resume previous sandbox")
  expect(html).toContain("Start with a fresh sandbox")
  expect(html).toContain("Its last change may be unfinished")
  expect(restores).toBe(0)
})

test("offers no resume for a workspace that has nothing to go on from", () => {
  const html = renderToStaticMarkup(
    createElement(SandboxRecovery, {
      pending: false,
      error: false,
      canRecreate: true,
      owner: "Alice Martin",
      onRecreate: () => {},
    })
  )
  expect(html).not.toContain("Resume previous sandbox")
})
