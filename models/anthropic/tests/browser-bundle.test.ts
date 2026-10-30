import { expect, test } from "bun:test"
import { join } from "node:path"
import { runInNewContext } from "node:vm"

// App bundles reach the provider through shared model bindings, so the bundled package must
// evaluate. Running it as a plain script keeps the engine's class initialization order.
test("the package evaluates when bundled for the browser", async () => {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/index.ts")],
    target: "browser",
    format: "iife",
  })

  expect(build.success).toBe(true)

  const script = await build.outputs[0]!.text()

  expect(() => runInNewContext(script, { URL, process: { env: {} } })).not.toThrow()
})
