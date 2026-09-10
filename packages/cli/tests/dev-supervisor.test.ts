import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const supervisor = resolve(import.meta.dir, "../src/lib/dev-supervisor.ts")

// Guard check: remove process.execArgv from the spawn arguments in dev-supervisor.ts.
// The child then reports null instead of the global initialized by the preload.
test.each([
  { runtimeArgs: ["--preload", "./preload.ts"] },
  { runtimeArgs: ["--preload=./preload.ts"] },
])("dev child preserves runtime options: %j", async ({ runtimeArgs }) => {
  const root = await mkdtemp(join(tmpdir(), "sixb-dev-supervisor-"))
  try {
    await writeFile(join(root, "preload.ts"), 'globalThis.preloaded = "initialized"\n')
    await writeFile(join(root, "sixb.config.ts"), "export default globalThis.preloaded ?? null\n")
    await writeFile(
      join(root, "entry.ts"),
      `
import { runDevSupervisor } from ${JSON.stringify(supervisor)}
if (process.env.SIXB_DEV_CHILD === "1") {
  const { default: value } = await import("./sixb.config.ts")
  console.log(JSON.stringify({ value, args: process.argv.slice(2) }))
  process.kill(process.ppid, "SIGTERM")
  process.exit(0)
} else {
  await runDevSupervisor({ entry: "./sixb.config.ts" })
}
`
    )
    const proc = Bun.spawn(
      [process.execPath, ...runtimeArgs, join(root, "entry.ts"), "dev", "--port", "4321"],
      {
        cwd: root,
        env: { ...process.env, SIXB_DEV_CHILD: "" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      }
    )
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(stdout).toContain(
      JSON.stringify({ value: "initialized", args: ["dev", "--port", "4321"] })
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 10_000)
