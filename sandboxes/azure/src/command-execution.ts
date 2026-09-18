import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { posix } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import {
  type CommandResult,
  type RunCommandOptions,
  SandboxError,
  type SandboxSessionOptions,
} from "@sixb/core/sandboxes"
import type { AzureSandboxClient } from "./azure-client"
import { positiveMilliseconds, withLifecycleDeadline } from "./lifecycle"

const DEFAULT_COMMAND_TIMEOUT = 300_000
const CONTROL_ENV = "/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8"
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64")

export function supervisorCommand(
  root: string,
  action: "start" | "status" | "cancel" | "files",
  id: string,
  payload?: string
): string {
  return `${CONTROL_ENV} node ${shellQuote(`${root}/supervisor.mjs`)} ${action} ${shellQuote(root)} ${id}${payload ? ` ${payload}` : ""}`
}

/** Install once, before unprivileged work can run. Image must supply Node and Linux tools. */
export async function installSupervisor(
  client: AzureSandboxClient,
  id: string,
  cwd: string,
  signal: AbortSignal,
  connected = false
): Promise<string> {
  // Both src/command-execution.ts and dist/index.js resolve this package-local artifact.
  let source: string
  try {
    source = readFileSync(new URL("../dist/guest/supervisor.mjs", import.meta.url), "utf8")
  } catch {
    throw new SandboxError(
      "[Sandbox] Azure guest supervisor artifact is unavailable. Run the Azure package build before creating a sandbox."
    )
  }
  const root = `/run/sixb-${randomUUID()}`
  const mkdir = await client.execute(id, `umask 077; mkdir -- ${shellQuote(root)}`, "/", { signal })
  if (mkdir.exitCode !== 0)
    throw new SandboxError("[Sandbox] Azure supervisor directory setup failed.")
  await client.writeFile(id, `${root}/supervisor.mjs`, source, 0o600, { signal })
  await client.writeFile(id, `${root}/network.json`, JSON.stringify({ connected }), 0o600, {
    signal,
  })
  const result = await client.execute(
    id,
    `${CONTROL_ENV} node ${shellQuote(`${root}/supervisor.mjs`)} init ${shellQuote(root)} ${randomUUID()} ${Buffer.from(cwd).toString("base64")}`,
    "/",
    { signal }
  )
  if (result.exitCode !== 0 || result.stdout !== '{"state":"ready"}') {
    throw new SandboxError(
      "[Sandbox] Azure image requires Node, Bash, unshare, setpriv, writable cgroup v2 with freeze/kill and a usable workspace."
    )
  }
  return root
}

export function validateEnvironment(env: Readonly<Record<string, string>> | undefined): void {
  if (
    env !== undefined &&
    (env === null ||
      typeof env !== "object" ||
      Array.isArray(env) ||
      Object.entries(env).some(
        ([key, value]) =>
          !key || /[=\0]/.test(key) || typeof value !== "string" || value.includes("\0")
      ))
  ) {
    throw new SandboxError(
      "[Sandbox] Azure env requires string values and non-empty names without '=' or NUL."
    )
  }
}

interface CommandInput {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs: number
}
export function resolveCommand(
  defaults: SandboxSessionOptions & { readonly workingDirectory: string },
  command: string,
  args: readonly string[],
  options: RunCommandOptions
): CommandInput {
  if (typeof command !== "string" || !command || command.includes("\0")) {
    throw new SandboxError(
      "[Sandbox] Azure command must be a non-empty executable name/path without NUL."
    )
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new SandboxError("[Sandbox] Azure command arguments must be strings without NUL.")
  }
  const cwd = options.cwd ?? defaults.workingDirectory
  if (typeof cwd !== "string" || !cwd || cwd.includes("\0"))
    throw new SandboxError("[Sandbox] Azure cwd must be a non-empty path without NUL.")
  validateEnvironment(options.env)
  return {
    command,
    args: [...args],
    cwd: posix.resolve(defaults.workingDirectory, cwd),
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      // Azure Full inspection signs destination certificates with the guest's injected CA.
      // Use the system trust bundle; never inherit host environment or disable TLS validation.
      ...(defaults.network?.mode === "restricted"
        ? { NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt" }
        : {}),
      ...defaults.env,
      ...options.env,
    },
    timeoutMs: positiveMilliseconds(
      options.timeout ?? defaults.timeout ?? DEFAULT_COMMAND_TIMEOUT,
      "timeout"
    ),
  }
}

interface CommandState {
  readonly state: "pending" | "accepted" | "done"
  readonly result?: CommandResult
}
function parseState(text: string): CommandState {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new SandboxError("[Sandbox] Invalid Azure supervisor response.")
  }
  if (!value || typeof value !== "object" || !("state" in value))
    throw new SandboxError("[Sandbox] Invalid Azure supervisor response.")
  if (value.state === "failed") {
    const reason = "reason" in value ? value.reason : undefined
    const detail =
      reason === "output-limit"
        ? "output exceeded the 1 MiB per-stream limit"
        : reason === "lease-expired"
          ? "worker heartbeat expired"
          : reason === "cleanup-failed"
            ? "process cleanup could not be confirmed"
            : "guest supervisor failed"
    throw new SandboxError(`[Sandbox] Azure ${detail}.`)
  }
  if (value.state === "pending" || value.state === "accepted") return { state: value.state }
  if (
    value.state === "done" &&
    "result" in value &&
    value.result &&
    typeof value.result === "object"
  ) {
    const result = value.result
    if (
      "exitCode" in result &&
      typeof result.exitCode === "number" &&
      Number.isInteger(result.exitCode) &&
      "stdout" in result &&
      typeof result.stdout === "string" &&
      "stderr" in result &&
      typeof result.stderr === "string" &&
      "durationMs" in result &&
      typeof result.durationMs === "number" &&
      Number.isFinite(result.durationMs) &&
      result.durationMs >= 0 &&
      (!("timedOut" in result) || typeof result.timedOut === "boolean")
    ) {
      return {
        state: "done",
        result: {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          ...("timedOut" in result && result.timedOut ? { timedOut: true } : {}),
        },
      }
    }
  }
  throw new SandboxError("[Sandbox] Invalid Azure supervisor result.")
}

/** Control requests are short; an HTTP deadline never doubles as a process deadline. */
export class AzureCommandExecution {
  constructor(
    private readonly client: AzureSandboxClient,
    private readonly sandboxId: string,
    private readonly root: string,
    private readonly cleanupTimeoutMs: number
  ) {}

  async run(input: CommandInput, signal: AbortSignal): Promise<CommandResult> {
    if (signal.aborted) return { exitCode: 137, stdout: "", stderr: "", durationMs: 0 }
    const commandId = randomUUID()
    const control = async (
      action: "start" | "status" | "cancel",
      payload?: string,
      abortSignal?: AbortSignal
    ) => {
      const response = await this.client.execute(
        this.sandboxId,
        supervisorCommand(this.root, action, commandId, payload),
        "/",
        { signal: abortSignal }
      )
      if (response.exitCode !== 0)
        throw new SandboxError("[Sandbox] Azure supervisor control request failed.")
      return parseState(response.stdout)
    }
    let cancelled: boolean = signal.aborted
    const onAbort = () => {
      cancelled = true
    }
    signal.addEventListener("abort", onAbort, { once: true })
    const hostDeadline = performance.now() + input.timeoutMs + this.cleanupTimeoutMs
    try {
      // Once issued, a start is never replayed, even if the response is lost.
      await control("start", encode(input))
      while (!cancelled && performance.now() < hostDeadline) {
        const state = await control("status")
        if (state.state === "done" && state.result) return state.result
        await delay(100, undefined, { signal }).catch(() => {})
      }
      return await withLifecycleDeadline(
        "command cancellation",
        this.cleanupTimeoutMs,
        async (cleanupSignal) => {
          let state = await control("cancel", undefined, cleanupSignal)
          while (state.state !== "done") {
            await delay(100, undefined, { signal: cleanupSignal })
            state = await control("status", undefined, cleanupSignal)
          }
          if (!state.result)
            throw new SandboxError("[Sandbox] Azure command cleanup was not confirmed.")
          // A lost supervisor deadline is a provider failure, not a fabricated timeout result.
          if (!cancelled)
            throw new SandboxError("[Sandbox] Azure command supervisor exceeded its deadline.")
          return state.result
        }
      )
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
  }
}
