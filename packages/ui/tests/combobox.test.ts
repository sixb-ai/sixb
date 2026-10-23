import { expect, test } from "bun:test"
import { resolve } from "node:path"

const SCRIPT_TIMEOUT_MS = 20_000

// The script needs a DOM installed before Radix loads, so it runs in its own process, bounded.
test(
  "a Combobox searched by its caller shows the caller's options and clears the search on close",
  async () => {
    const script = Bun.spawn({
      cmd: [process.execPath, resolve(import.meta.dir, "combobox-search.tsx")],
      cwd: resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const killTimer = setTimeout(() => script.kill("SIGKILL"), SCRIPT_TIMEOUT_MS)

    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        script.exited,
        new Response(script.stdout).text(),
        new Response(script.stderr).text(),
      ])
      expect({ exitCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      })
      expect(stdout).toContain("combobox search: ok")
    } finally {
      clearTimeout(killTimer)
    }
  },
  SCRIPT_TIMEOUT_MS + 5_000
)
