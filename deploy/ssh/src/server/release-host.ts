import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import type { ReleaseHost } from "./release"
import { isMissing, readProcessState, writeFileAtomically } from "./state"
import { sendSupervisorCommand } from "./supervisor"

/** The server itself: commands share the release's log, and systemd is the account's own. */
export function createReleaseHost(): ReleaseHost {
  const run: ReleaseHost["run"] = async (command, options = {}) => {
    const child = Bun.spawn([...command], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: { ...process.env, ...options.env },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    })
    return child.exited
  }
  const quiet = async (command: readonly string[]) => {
    const child = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, output: `${stdout}${stderr}` }
  }

  return {
    run,
    systemctl: (...args) => run(["systemctl", "--user", ...args]),
    // Not `is-active`, which fails for a unit that is still stopping: a draining slot holds its
    // ports, and a legacy service reads its files, until it reaches `inactive` or `failed`.
    isActive: async (unit) => {
      const { output } = await quiet([
        "systemctl",
        "--user",
        "show",
        "-p",
        "ActiveState",
        "--value",
        unit,
      ])
      return !["inactive", "failed", ""].includes(output.trim())
    },
    readRoutes: async (path) =>
      readFile(path, "utf8").catch((error: unknown) => {
        if (isMissing(error)) return null
        throw error
      }),
    writeRoutes: async (path, routes) => {
      if (routes === null) await rm(path, { force: true })
      else await writeFileAtomically(path, routes)
    },
    validateCaddy: async () => {
      const result = await quiet([
        "caddy",
        "validate",
        "--config",
        "/etc/caddy/Caddyfile",
        "--adapter",
        "caddyfile",
      ])
      return result.code === 0 ? null : result.output.trimEnd().split("\n").slice(-20).join("\n")
    },
    reloadCaddy: async () =>
      (await run(["sudo", "-n", "/usr/bin/systemctl", "reload", "caddy"])) === 0,
    answers: async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) }).catch(() => null)
      return response?.ok === true
    },
    supervise: async (runDir, command, service) => {
      await sendSupervisorCommand({ runDir }, command, { service })
    },
    readState: (runDir) => readProcessState(join(runDir, "state.json")),
    sleep: (ms) => Bun.sleep(ms),
    print: (line) => console.log(line),
  }
}
