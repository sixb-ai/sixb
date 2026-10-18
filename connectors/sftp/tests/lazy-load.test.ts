import { expect, test } from "bun:test"
import { resolve } from "node:path"

// Module loading is per process: the runner needs a module graph that has not loaded ssh2 yet,
// which the shared test process cannot promise. The crypto check can only fail on a host where
// ssh2's optional sshcrypto addon built during install; elsewhere ssh2 is on JavaScript crypto anyway.
const RUNNER = `
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const entry = process.env.SFTP_ENTRY
const ssh2Loaded = () => Object.keys(require.cache).some((path) => path.includes("/node_modules/ssh2/"))
const { createSshClient, sftp } = await import(entry)

const adapter = sftp({ host: "example.com", username: "demo", password: "secret" })
if (adapter.type !== "sftp") throw new Error("Unexpected connector type")
if (ssh2Loaded()) throw new Error("ssh2 loaded before a connection was requested")

const client = await createSshClient()
client.end()
const localRequire = createRequire(entry)
const crypto = localRequire(join(dirname(localRequire.resolve("ssh2")), "protocol", "crypto.js"))
if (crypto.bindingAvailable !== false) throw new Error("ssh2 native crypto was loaded")
`

test("loads ssh2 only for a connection, and on its JavaScript crypto under Bun", async () => {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, "-e", RUNNER],
    env: { ...process.env, SFTP_ENTRY: resolve(import.meta.dir, "..", "src", "index.ts") },
    stdout: "ignore",
    stderr: "pipe",
    timeout: 10_000,
    killSignal: "SIGKILL",
  })

  const [stderr, exitCode] = await Promise.all([
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ])

  expect(stderr).toBe("")
  expect(exitCode).toBe(0)
})
