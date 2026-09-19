/**
 * Azure request cancellation does not terminate the command running in the guest.
 * Sixb needs a guest-side supervisor to enforce command deadlines and cancellation,
 * collect output, and confirm that no descendants remain before returning a result.
 * Killing only the foreground process or its process group misses detached children,
 * so each workload enters a dedicated cgroup that can be killed and checked for emptiness.
 *
 * The worker sends short start/status/cancel requests rather than holding an execution
 * request open for the lifetime of the command. A heartbeat lease also bounds orphaned
 * work if the worker disappears. Protected cancellation markers prevent delayed starts
 * from launching work after cancellation has already been acknowledged.
 *
 * This supervisor runs as root inside the Azure guest, never on the Sixb worker.
 * Root is needed to manage cgroups and network namespaces; workloads drop privileges
 * and capabilities before execution and cannot modify the supervisor's control files.
 * Network mode comes from a root-only session file: deny-all commands enter a fresh
 * network namespace; connected commands use the Azure policy applied at VM creation.
 * All workload cgroups share a parent so file publication can freeze them together,
 * preventing directory/symlink swaps while the guest helper validates and writes paths.
 * The package build compiles this TypeScript into standalone Node JavaScript, so the
 * guest needs neither Bun nor a TypeScript compiler.
 */

import { type ChildProcess, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import {
  publishStagedFiles,
  setWorkloadsFrozen,
  workloadGroup,
  workspaceIdentity,
} from "./workspace-files"

interface CommandInput {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs: number
}

type StopReason =
  | "cancelled"
  | "timeout"
  | "output-limit"
  | "lease-expired"
  | "supervisor-failed"
  | "cleanup-failed"
type ProcessOutcome = { readonly code: number } | { readonly error: true }

/** Control files originate from the worker, but remain an explicit JSON boundary. */
function parseInput(text: string): CommandInput {
  const value: unknown = JSON.parse(text)
  if (
    !value ||
    typeof value !== "object" ||
    !("command" in value) ||
    typeof value.command !== "string" ||
    !("args" in value) ||
    !Array.isArray(value.args) ||
    !value.args.every((arg: unknown) => typeof arg === "string") ||
    !("cwd" in value) ||
    typeof value.cwd !== "string" ||
    !("env" in value) ||
    !value.env ||
    typeof value.env !== "object" ||
    Array.isArray(value.env) ||
    !("timeoutMs" in value) ||
    typeof value.timeoutMs !== "number" ||
    !Number.isInteger(value.timeoutMs) ||
    value.timeoutMs <= 0
  ) {
    throw new Error("invalid command input")
  }
  const env: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value.env)) {
    if (typeof entry !== "string") throw new Error("invalid command environment")
    Object.defineProperty(env, key, { value: entry, enumerable: true })
  }
  return {
    command: value.command,
    args: value.args,
    cwd: value.cwd,
    env,
    timeoutMs: value.timeoutMs,
  }
}

const SAFE_ENV = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" }
const MAX_OUTPUT = 1024 * 1024
const LEASE_MS = 60_000
const KILL_MS = 10_000
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("deadline")), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const json = (file: string, value: unknown): void => {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 })
  fs.renameSync(`${file}.tmp`, file)
}

async function terminate(
  child: ChildProcess | undefined,
  childExited: Promise<number> | undefined,
  group: string | undefined
): Promise<void> {
  // Kill the direct launcher first and await its exit before the final cgroup kill.
  // Otherwise cancellation can race its initial move into the cgroup.
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  if (childExited) {
    await bounded(
      childExited.catch(() => {}),
      KILL_MS
    )
  }
  if (group) {
    // Kill background/setsid descendants even when the foreground command succeeded.
    fs.writeFileSync(`${group}/cgroup.kill`, "1")
    const deadline = performance.now() + KILL_MS
    while (!/^populated 0$/m.test(fs.readFileSync(`${group}/cgroup.events`, "utf8"))) {
      if (performance.now() >= deadline) throw new Error("cgroup populated")
      await delay(10)
    }
    fs.rmdirSync(group)
  }
}

async function worker(root: string, id: string): Promise<void> {
  const directory = path.join(root, id)
  const group = `${workloadGroup(root)}/${id}`
  const started = performance.now()
  const input = parseInput(fs.readFileSync(path.join(directory, "input"), "utf8"))
  let child: ChildProcess | undefined
  let childExited: Promise<number> | undefined
  let childClosed: Promise<void> | undefined
  let monitor: ReturnType<typeof setInterval> | undefined
  let reason: StopReason | undefined
  let groupCreated = false
  let stdout: Buffer = Buffer.alloc(0)
  let stderr: Buffer = Buffer.alloc(0)
  let result: { readonly exitCode: number } | undefined
  const cancelled = () => fs.existsSync(path.join(directory, "cancel"))
  const collect = (stream: "stdout" | "stderr", data: Buffer): void => {
    const current = stream === "stdout" ? stdout : stderr
    if (current.length + data.length > MAX_OUTPUT) {
      reason ??= "output-limit"
      return
    }
    if (stream === "stdout") stdout = Buffer.concat([current, data])
    else stderr = Buffer.concat([current, data])
  }
  try {
    if (cancelled()) {
      reason = "cancelled"
    } else {
      fs.mkdirSync(group, { mode: 0o700 })
      groupCreated = true
      fs.accessSync(`${group}/cgroup.kill`, fs.constants.W_OK)
      // No user text is evaluated by the privileged shell. Its environment is fixed.
      // setpriv applies no-new-privileges and drops all capabilities before env/exec.
      const network: unknown = JSON.parse(fs.readFileSync(path.join(root, "network.json"), "utf8"))
      if (
        !network ||
        typeof network !== "object" ||
        !("connected" in network) ||
        typeof network.connected !== "boolean"
      )
        throw new Error("invalid network configuration")
      const argv = [
        ...(network.connected ? [] : ["/usr/bin/unshare", "--net", "--"]),
        "/usr/bin/setpriv",
        "--reuid=65534",
        "--regid=65534",
        "--clear-groups",
        "--no-new-privs",
        "--bounding-set=-all",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "/usr/bin/env",
        "-i",
        "--",
        ...Object.entries(input.env).map(([key, value]) => `${key}=${value}`),
        "/bin/bash",
        "--noprofile",
        "--norc",
        "-c",
        'exec -- "$@"',
        "--",
        input.command,
        ...input.args,
      ]
      const launch = `printf '%s' "$$" > ${quote(`${group}/cgroup.procs`)} && exec ${argv.map(quote).join(" ")}`
      const launched = spawn("/bin/bash", ["-c", launch], {
        cwd: input.cwd,
        env: SAFE_ENV,
        stdio: ["ignore", "pipe", "pipe"],
      })
      child = launched
      childClosed = new Promise<void>((resolve) => launched.once("close", () => resolve()))
      launched.stdout.on("data", (data) => collect("stdout", data))
      launched.stderr.on("data", (data) => collect("stderr", data))
      childExited = new Promise<number>((resolve, reject) => {
        launched.once("error", reject)
        launched.once("exit", (code) => resolve(code ?? 137))
      })
      // Handle a rejected spawn immediately even while the monitor is being set up.
      const completed: Promise<ProcessOutcome> = childExited.then(
        (code) => ({ code }),
        () => ({ error: true })
      )
      const interrupted = new Promise<ProcessOutcome>((resolve) => {
        const check = () => {
          if (cancelled()) reason ??= "cancelled"
          if (performance.now() - started >= input.timeoutMs) reason ??= "timeout"
          if (Date.now() - fs.statSync(path.join(directory, "lease")).mtimeMs > LEASE_MS)
            reason ??= "lease-expired"
          if (reason) resolve({ code: 137 })
        }
        monitor = setInterval(check, 25)
        check()
      })
      const outcome = await Promise.race([completed, interrupted])
      if ("error" in outcome) throw new Error("spawn failed")
      result = { exitCode: outcome.code }
    }
  } catch {
    reason = "supervisor-failed"
  } finally {
    clearInterval(monitor)
    try {
      await terminate(child, childExited, groupCreated ? group : undefined)
    } catch {
      reason = "cleanup-failed"
    }
    // Pipes may flush after the exit event. Wait for close once the descendants are dead.
    if (childClosed) {
      try {
        await bounded(childClosed, KILL_MS)
      } catch {
        reason = "cleanup-failed"
      }
    }
    const fatal = reason && !["timeout", "cancelled"].includes(reason)
    json(
      path.join(directory, "result"),
      fatal
        ? { state: "failed", reason }
        : {
            state: "done",
            result: {
              exitCode: reason ? 137 : (result?.exitCode ?? 137),
              stdout: stdout.toString("utf8"),
              stderr: stderr.toString("utf8"),
              durationMs: performance.now() - started,
              ...(reason === "timeout" ? { timedOut: true } : {}),
            },
          }
    )
    fs.rmSync(path.join(directory, "input"), { force: true })
  }
}

async function main(): Promise<unknown> {
  const [action, root, id, encoded] = process.argv.slice(2)
  if (!root || !id || !/^\/run\/sixb-[0-9a-f-]{36}$/.test(root) || !/^[0-9a-f-]{36}$/.test(id))
    throw new Error("invalid control path")
  if (process.getuid?.() !== 0) throw new Error("root supervisor required")
  if (action === "init") {
    if (!encoded) throw new Error("missing workspace")
    const cwd = Buffer.from(encoded, "base64").toString("utf8")
    fs.mkdirSync(cwd, { recursive: true })
    const resolved = fs.realpathSync(cwd)
    const reserved = [
      "/",
      "/tmp",
      "/home",
      "/bin",
      "/sbin",
      "/usr",
      "/lib",
      "/lib64",
      "/etc",
      "/proc",
      "/sys",
      "/run",
      "/dev",
      "/root",
      "/boot",
      "/opt",
      "/var",
    ]
    if (
      reserved.some(
        (entry) =>
          resolved === entry ||
          (!["/", "/tmp", "/home"].includes(entry) && resolved.startsWith(`${entry}/`))
      )
    ) {
      throw new Error("reserved workspace")
    }
    const identity = workspaceIdentity(cwd)
    fs.chownSync(cwd, 65534, 65534)
    fs.chmodSync(cwd, 0o700)
    json(path.join(root, "workspace.json"), identity)
    // All command cgroups live below this root so file publication can freeze
    // existing workloads and any command that starts concurrently.
    const group = workloadGroup(root)
    fs.mkdirSync(group, { mode: 0o700 })
    fs.accessSync(`${group}/cgroup.kill`, fs.constants.W_OK)
    await setWorkloadsFrozen(root, true)
    await setWorkloadsFrozen(root, false)
    const check = spawn(
      "/usr/bin/unshare",
      [
        "--net",
        "--",
        "/usr/bin/setpriv",
        "--reuid=65534",
        "--regid=65534",
        "--clear-groups",
        "--no-new-privs",
        "--bounding-set=-all",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "/bin/true",
      ],
      { env: SAFE_ENV, stdio: "ignore" }
    )
    const code = await new Promise((resolve, reject) => {
      check.once("error", reject)
      check.once("exit", resolve)
    })
    if (code !== 0) throw new Error("isolation unavailable")
    return { state: "ready" }
  }
  if (action === "files") return publishStagedFiles(root, id)
  const directory = path.join(root, id)
  if (action === "worker") return worker(root, id)
  if (action === "start") {
    try {
      fs.mkdirSync(directory, { mode: 0o700 })
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST")
        return { state: "accepted" }
      throw error
    }
    if (!encoded) throw new Error("missing command input")
    json(path.join(directory, "input"), parseInput(Buffer.from(encoded, "base64").toString("utf8")))
    fs.writeFileSync(path.join(directory, "lease"), "", { mode: 0o600 })
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "worker", root, id], {
      detached: true,
      env: SAFE_ENV,
      stdio: "ignore",
    })
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve())
      child.once("error", reject)
    })
    child.unref()
    return { state: "accepted" }
  }
  if (action === "cancel") {
    // Keep this tombstone until VM deletion. A delayed start must never launch work.
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(directory, "cancel"), "", { mode: 0o600 })
  } else if (action !== "status") throw new Error("unknown action")
  if (fs.existsSync(path.join(directory, "result")))
    return JSON.parse(fs.readFileSync(path.join(directory, "result"), "utf8"))
  if (
    fs.existsSync(path.join(directory, "cancel")) &&
    !fs.existsSync(path.join(directory, "input"))
  ) {
    return { state: "done", result: { exitCode: 137, stdout: "", stderr: "", durationMs: 0 } }
  }
  fs.writeFileSync(path.join(directory, "lease"), "", { mode: 0o600 })
  return { state: "pending" }
}

main()
  .then((value) => {
    if (value) process.stdout.write(JSON.stringify(value))
  })
  .catch(() => {
    process.stderr.write("Sixb guest supervisor failed")
    process.exitCode = 1
  })
