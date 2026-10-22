import { mock } from "bun:test"
import * as fs from "node:fs/promises"
import { basename, dirname, join } from "node:path"

const persist = fs.writeFile

// Preloaded only in the child supervisor: a write into run/responses creates its file empty, then
// holds before the content lands, which is what a reader polling that directory can catch.
mock.module("node:fs/promises", () => ({
  ...fs,
  async writeFile(...args: Parameters<typeof fs.writeFile>): Promise<void> {
    const [path] = args
    if (typeof path === "string" && basename(dirname(path)) === "responses") {
      await persist(path, "")
      const run = dirname(dirname(path))
      await persist(join(run, "response-write-held"), "")
      const release = join(run, "release-response-write")
      const deadline = Date.now() + 5_000
      while (!(await Bun.file(release).exists())) {
        if (Date.now() >= deadline) throw new Error("Timed out releasing the held response.")
        await Bun.sleep(10)
      }
    }
    await persist(...args)
  },
}))
