import { isIPv6 } from "node:net"
import type {
  DeployCheck,
  DeployCheckContext,
  DeployContext,
  DeployControlAction,
  DeployHttpServiceName,
  DeployListenAddress,
  DeployLogsOptions,
  DeployOperationContext,
  DeployRelease,
  DeployScript,
  DeploySource,
  DeployStatus,
  DeployTarget,
} from "@sixb/core/deploy"
import { checkDns, checkHost } from "./check"
import { SLOT_PORTS } from "./layout"
import {
  controlServices,
  deployRelease,
  readStatus,
  runDeployScript,
  streamLogs,
} from "./operations"
import { resolveSshConfig } from "./ssh-config"
import { type RemoteShell, SshShell } from "./transport"

export interface SshTargetOptions {
  /** The server: a hostname, an IP address, or a `Host` alias from your SSH config. */
  readonly host: string
  /** The account the deployment logs in and runs as, never `root`. Defaults to `"sixb"`. */
  readonly user?: string
}

const DEFAULT_USER = "sixb"

/** Options earlier versions took, and why they went. */
const REMOVED_OPTIONS: Readonly<Record<string, string>> = {
  ports: "a server runs one deployment, on fixed ports",
  standbyPorts: "a server runs one deployment, on fixed ports",
}

/** A Linux account name `useradd` accepts. */
const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/

/** Services listen on loopback only: Caddy on the same server is their one way in. */
const LISTEN_HOST = "127.0.0.1"

/** A server reached over SSH, where Caddy routes each domain to its service. */
export class SshTarget implements DeployTarget {
  readonly kind = "ssh"
  readonly host: string
  /** The account the deployment logs in and runs as. */
  readonly user: string
  readonly location: string

  constructor(options: SshTargetOptions) {
    if (typeof options !== "object" || options === null) {
      throw new Error(
        '[SshTarget] Pass options, such as `new SshTarget({ host: "203.0.113.10" })`.'
      )
    }
    for (const key of Object.keys(options)) {
      const removed = REMOVED_OPTIONS[key]
      if (removed) throw new Error(`[SshTarget] Remove \`${key}\`: ${removed}.`)
      if (key !== "host" && key !== "user") {
        throw new Error(`[SshTarget] Unknown option '${key}'. Available: host, user.`)
      }
    }

    this.host = validateHost(options.host)
    this.user = validateUser(options.user ?? DEFAULT_USER)
    this.location = `${this.user}@${this.host}`
  }

  listenAddress(service: DeployHttpServiceName): DeployListenAddress {
    return { host: LISTEN_HOST, port: SLOT_PORTS.blue[service] }
  }

  deploy(release: DeployRelease, source: DeploySource, context: DeployContext): Promise<void> {
    return this.#connected((shell) => deployRelease(shell, release, source, context))
  }

  status(context: DeployOperationContext): Promise<DeployStatus> {
    return this.#connected((shell) => readStatus(shell, context.name))
  }

  logs(options: DeployLogsOptions, context: DeployOperationContext): Promise<void> {
    // Following in a terminal attaches it, so Ctrl-C stops the remote reader too.
    const terminal = options.follow && Boolean(process.stdin.isTTY && process.stdout.isTTY)
    return this.#connected((shell) => streamLogs(shell, context.name, { ...options, terminal }))
  }

  control(
    action: DeployControlAction,
    service: string | undefined,
    context: DeployOperationContext
  ): Promise<void> {
    return this.#connected((shell) => controlServices(shell, context.name, action, service))
  }

  run(script: DeployScript, context: DeployOperationContext): Promise<number> {
    return this.#connected((shell) => runDeployScript(shell, context.name, script))
  }

  async check(release: DeployRelease, context: DeployCheckContext): Promise<DeployCheck[]> {
    const { hostname } = await resolveSshConfig(this.location)
    const dns = checkDns(release, hostname)
    let server: DeployCheck[]
    try {
      server = await this.#connected(async (shell) => [
        { id: "ssh", label: "SSH", status: "ok" as const, detail: this.location },
        ...(await checkHost(shell, {
          name: context.name,
          projectPath: context.projectPath,
          ports: [...Object.values(SLOT_PORTS.blue), ...Object.values(SLOT_PORTS.green)],
          settings:
            release.steps.env === undefined
              ? "env-file"
              : context.envToken
                ? "env-token"
                : "identity",
          chromium: context.chromium,
        })),
      ])
    } catch (error) {
      server = [sshCheck(this.location, error)]
    }
    return [...server, ...(await dns)]
  }

  async #connected<T>(work: (shell: RemoteShell) => Promise<T>): Promise<T> {
    const shell = await SshShell.open(this.location)
    try {
      return await work(shell)
    } finally {
      await shell.close()
    }
  }
}

function validateUser(value: unknown): string {
  if (value === "root") {
    throw new Error("[SshTarget] Deployments never run as root. Use an account without sudo.")
  }
  if (typeof value !== "string" || !USER_PATTERN.test(value)) {
    throw new Error(
      `[SshTarget] user ${JSON.stringify(value)} is not a Linux account name. Use lowercase ` +
        "letters, digits, underscores and hyphens, starting with a letter or underscore."
    )
  }
  return value
}

function validateHost(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("[SshTarget] host must be the server's hostname or IP address.")
  }
  const host = value.trim()
  if (host.includes("@")) {
    throw new Error(
      `[SshTarget] host '${host}' includes a user. Set the host alone, and the account with \`user\`.`
    )
  }
  // `ssh` reads an argument that starts with `-` as an option, not a host.
  if (host.startsWith("-") || /[\s/\\]/.test(host)) {
    throw new Error(`[SshTarget] host '${host}' is not a hostname or IP address.`)
  }
  if (host.includes(":") && !isIPv6(host)) {
    throw new Error(
      `[SshTarget] host '${host}' includes a port. For an SSH port other than 22, add a Host ` +
        "entry with that Port to your SSH config and use its name as the host."
    )
  }
  return host
}

/** A failed connection, as the check that stops a deploy. */
function sshCheck(location: string, error: unknown): DeployCheck {
  const [message = ""] = (error instanceof Error ? error.message : String(error)).split("\n")
  return {
    id: "ssh",
    label: "SSH",
    status: "fail",
    detail: message.replace(/^\[SshTarget\] /, "") || `Cannot reach ${location}.`,
  }
}
