import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { WorkspaceRecovery } from "../src/components/WorkspaceRecovery"

test("offers explicit workspace recreation without performing it during render", () => {
  let calls = 0
  const html = renderToStaticMarkup(
    createElement(WorkspaceRecovery, {
      pending: false,
      error: false,
      onRecreate: () => {
        calls++
      },
    })
  )
  expect(html).toContain("Workspace recovery required")
  expect(html).toContain("Start with a fresh workspace")
  expect(html).toContain("Automatic resume is blocked")
  expect(calls).toBe(0)
})

test("disables duplicate recovery requests and exposes failures", () => {
  const html = renderToStaticMarkup(
    createElement(WorkspaceRecovery, {
      pending: true,
      error: true,
      onRecreate: () => {},
    })
  )
  expect(html).toContain("disabled")
  expect(html).toContain('role="alert"')
  expect(html).toContain("Could not recreate")
})
