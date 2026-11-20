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
import { checkDns, runChecks } from "./check"
import { DEPLOY_USER, SLOT_PORTS } from "./layout"
import {
  controlServices,
  deployRelease,
  readStatus,
  runDeployScript,
  streamLogs,
} from "./operations"
import { resolveSshConfig } from "./ssh-config"
import { RemoteScriptError, type RemoteShell, SshShell } from "./transport"

export interface SshTargetOptions {
  /** The server: a hostname, an IP address, or a `Host` alias from your SSH config. */
  readonly host: string
}

/** Options earlier versions took, and why they went. */
const REMOVED_OPTIONS: Readonly<Record<string, string>> = {
  user: "deployments run as `sixb`",
  ports: "a server runs one deployment, on fixed ports",
  standbyPorts: "a server runs one deployment, on fixed ports",
}

/** Services listen on loopback only: Caddy on the same server is their one way in. */
const LISTEN_HOST = "127.0.0.1"

/** A server reached over SSH as `sixb`, where Caddy routes each domain to its service. */
export class SshTarget implements DeployTarget {
  readonly kind = "ssh"
  readonly host: string
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
      if (key !== "host") throw new Error(`[SshTarget] Unknown option '${key}'. Available: host.`)
    }

    this.host = validateHost(options.host)
    this.location = `${DEPLOY_USER}@${this.host}`
  }

  listenAddress(service: DeployHttpServiceName): DeployListenAddress {
    return { host: LISTEN_HOST, port: SLOT_PORTS.blue[service] }
  }

  deploy(release: DeployRelease, source: DeploySource, context: DeployContext): Promise<void> {
    return this.#connected((shell) => deployRelease(shell, release, source, context, SLOT_PORTS))
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
        ...(await runChecks(shell, {
          name: context.name,
          projectPath: context.projectPath,
          ports: release.services.flatMap((service) => {
            if (!service.http || (service.name !== "api" && service.name !== "app")) return []
            return [
              { service: service.name, port: SLOT_PORTS.blue[service.name] },
              { service: `${service.name}-standby`, port: SLOT_PORTS.green[service.name] },
            ]
          }),
          envFromSource: release.steps.env !== undefined,
          location: this.location,
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

function validateHost(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("[SshTarget] host must be the server's hostname or IP address.")
  }
  const host = value.trim()
  if (host.includes("@")) {
    throw new Error(
      `[SshTarget] host '${host}' includes a user. Set the host alone: deploys connect as \`sixb\`.`
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

/** What a failed connection means for a deploy. */
function sshCheck(location: string, error: unknown): DeployCheck {
  const message =
    (error instanceof Error ? error.message : String(error))
      .split("\n")[0]
      ?.replace(/^\[SshTarget\] /, "") ?? ""
  if (error instanceof RemoteScriptError && /refused your SSH key/.test(message)) {
    return {
      id: "ssh",
      label: "SSH",
      status: "fixable",
      detail: message,
      remedy: "Give your key access to the server's deploy account.",
    }
  }
  return {
    id: "ssh",
    label: "SSH",
    status: "manual",
    detail: message || `Cannot reach ${location}.`,
  }
}
