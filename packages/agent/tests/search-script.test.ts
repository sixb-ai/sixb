import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const packageRoot = resolve(import.meta.dir, "..")
const scriptPath = resolve(packageRoot, "src", "generated", "search.mjs")
const PROCESS_TIMEOUT_MS = 10_000

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("search.mjs, the generated search script", () => {
  // Reproduce: change a message in src/tools/search/command.ts without
  // `bun run generate:search-script`; the check then fails.
  test(
    "is current, small, and imports nothing but Node's built-ins",
    async () => {
      const check = await run([process.execPath, "./scripts/generate-search-script.ts", "--check"])
      expect({ exitCode: check.exitCode, stderr: check.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      })
      expect(check.stdout).toContain("Generated search script is current")

      // Every run installs it, and every search starts it.
      const script = await readFile(scriptPath, "utf8")
      const imported = [...script.matchAll(/^import .* from "([^"]+)";?$/gm)].map(
        (found) => found[1]
      )
      expect(imported.length).toBeGreaterThan(0)
      expect(imported.filter((specifier) => !specifier?.startsWith("node:"))).toEqual([])
      expect(Buffer.byteLength(script)).toBeLessThan(60_000)
    },
    PROCESS_TIMEOUT_MS + 5_000
  )

  // The tools run it on Bun where the sandbox has it: Node, as on Vercel's stock runtime, is only
  // reached here.
  test(
    "prints the same line on Bun and on Node",
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "sixb-search-script-")))
      roots.push(root)
      await mkdir(join(root, "src"))
      await writeFile(join(root, "src", "a.ts"), "const retries = 3\n")
      await writeFile(join(root, "src", "b.ts"), "const delay = 1\n")

      const request = JSON.stringify({ tool: "grep", pattern: "retries", timeoutMs: 5_000 })
      const expected = {
        exitCode: 0,
        stdout: `${JSON.stringify({
          matches: [{ path: "src/a.ts", line: 1, text: "const retries = 3" }],
          files: 1,
          truncated: false,
        })}\n`,
        stderr: "",
      }

      expect(await run([process.execPath, scriptPath, request], root)).toEqual(expected)
      expect(await run(["node", scriptPath, request], root)).toEqual(expected)
      expect(await run(["node", scriptPath, "{"], root)).toEqual({
        exitCode: 2,
        stdout: "",
        stderr: `${JSON.stringify({
          error: { code: "invalid_arguments", message: "The search request is not valid JSON." },
        })}\n`,
      })
    },
    PROCESS_TIMEOUT_MS * 3 + 5_000
  )
})

async function run(
  cmd: readonly string[],
  cwd = packageRoot
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn({ cmd: [...cmd], cwd, stdout: "pipe", stderr: "pipe" })
  let timedOut = false
  const killTimer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, PROCESS_TIMEOUT_MS)

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (timedOut)
      throw new Error(`${cmd.join(" ")} exceeded ${PROCESS_TIMEOUT_MS}ms and was killed.`)
    return { exitCode, stdout, stderr }
  } finally {
    clearTimeout(killTimer)
  }
}
