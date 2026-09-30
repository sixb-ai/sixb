import { isIPv6 } from "node:net"
import type { DeployHttpServiceName, DeployListenAddress, DeployTarget } from "@sixb/core/deploy"

export interface SshTargetOptions {
  /** The server: a hostname, an IP address, or a `Host` alias from your SSH config. */
  readonly host: string
  /**
   * The Linux user the deployment runs as. Projects under one user can read each other's files,
   * so give a project its own user to wall it off from the others on the server. Defaults to
   * `"sixb"`.
   */
  readonly user?: string
  /**
   * Local ports for the HTTP services, which Caddy on the server forwards to. Set them when
   * projects share a server, so that each has its own. Defaults: atlas 3000, app 3001, api 3002.
   */
  readonly ports?: Readonly<Partial<Record<DeployHttpServiceName, number>>>
}

const OPTIONS = ["host", "user", "ports"] as const

const DEFAULT_USER = "sixb"

const DEFAULT_PORTS = {
  atlas: 3000,
  app: 3001,
  api: 3002,
} as const satisfies Record<DeployHttpServiceName, number>

/** Services listen on loopback only: Caddy on the same server is their one way in. */
const LISTEN_HOST = "127.0.0.1"

/** A Linux account name `useradd` accepts. */
const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/

/** A server reached over SSH, where Caddy routes each domain to its service. */
export class SshTarget implements DeployTarget {
  readonly kind = "ssh"
  readonly host: string
  readonly user: string
  readonly location: string
  readonly #ports: Readonly<Record<DeployHttpServiceName, number>>

  constructor(options: SshTargetOptions) {
    if (typeof options !== "object" || options === null) {
      throw new Error(
        '[SshTarget] Pass options, such as `new SshTarget({ host: "203.0.113.10" })`.'
      )
    }
    for (const key of Object.keys(options)) {
      if (!(OPTIONS as readonly string[]).includes(key)) {
        throw new Error(`[SshTarget] Unknown option '${key}'. Available: ${OPTIONS.join(", ")}.`)
      }
    }

    this.host = validateHost(options.host)
    this.user = validateUser(options.user ?? DEFAULT_USER)
    this.location = `${this.user}@${this.host}`
    this.#ports = { ...DEFAULT_PORTS, ...validatePorts(options.ports) }
  }

  listenAddress(service: DeployHttpServiceName): DeployListenAddress {
    return { host: LISTEN_HOST, port: this.#ports[service] }
  }
}

function validateHost(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("[SshTarget] host must be the server's hostname or IP address.")
  }
  const host = value.trim()
  if (host.includes("@")) {
    throw new Error(
      `[SshTarget] host '${host}' includes a user. Set the host alone, and the user with \`user\`.`
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

function validateUser(value: unknown): string {
  if (value === "root") {
    throw new Error(
      "[SshTarget] Deployments never run as root. Use a deploy user without sudo, such as the " +
        'default "sixb".'
    )
  }
  if (typeof value !== "string" || !USER_PATTERN.test(value)) {
    throw new Error(
      `[SshTarget] user ${JSON.stringify(value)} is not a Linux user name. Use lowercase ` +
        "letters, digits, underscores, and hyphens, starting with a letter or underscore."
    )
  }
  return value
}

function validatePorts(value: unknown): Partial<Record<DeployHttpServiceName, number>> {
  if (value === undefined) return {}
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("[SshTarget] ports must be an object, such as `{ api: 3012 }`.")
  }

  const ports: Partial<Record<DeployHttpServiceName, number>> = {}
  for (const [service, port] of Object.entries(value)) {
    if (!Object.hasOwn(DEFAULT_PORTS, service)) {
      throw new Error(
        `[SshTarget] ports.${service} is not an HTTP service. Available: api, atlas, app.`
      )
    }
    // A deploy user has no privileges, and ports below 1024 need them.
    if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
      throw new Error(`[SshTarget] ports.${service} must be a port from 1024 to 65535.`)
    }
    ports[service as DeployHttpServiceName] = port
  }
  return ports
}
