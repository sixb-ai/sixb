import { isIPv6 } from "node:net"
import type {
  DeployAccess,
  DeployAccessKey,
  DeployCheck,
  DeployCheckContext,
  DeployCi,
  DeployCiCredential,
  DeployContext,
  DeployControlAction,
  DeployHttpServiceName,
  DeployListenAddress,
  DeployLogsOptions,
  DeployOperationContext,
  DeployRelease,
  DeploySetupContext,
  DeploySource,
  DeployStatus,
  DeployTarget,
} from "@sixb/core/deploy"
import { addKey, listKeys, removeKeys, removeKeysWhere } from "./access"
import { checkDns, runChecks } from "./check"
import { generateCiKey, knownHostsLines, readHostKeys, renderCiInstall } from "./ci"
import { controlServices, deployRelease, readStatus, streamLogs } from "./operations"
import { pickPublicKey, renderAdminScript } from "./setup"
import { shellQuote } from "./shell"
import { resolveSshConfig } from "./ssh-config"
import { RemoteScriptError, type RemoteShell, SshShell } from "./transport"

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

  deploy(release: DeployRelease, source: DeploySource, context: DeployContext): Promise<void> {
    return this.#connected((shell) => deployRelease(shell, this.user, release, source, context))
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
          ports: release.services.flatMap((service) =>
            service.http ? [{ service: service.name, port: service.http.port }] : []
          ),
          location: this.location,
        })),
      ])
    } catch (error) {
      server = [sshCheck(this.location, error)]
    }
    return [...server, ...(await dns)]
  }

  /**
   * Prepares the server as the admin login when the deploy user or the server is not set up
   * yet, then the project as the deploy user. Running it again changes nothing that is right.
   */
  async setup(release: DeployRelease, context: DeploySetupContext): Promise<void> {
    const before = await this.check(release, context)
    const serverFixes = before.filter(
      (check) =>
        (check.status === "fixable" && check.id !== "project.env") ||
        (check.id === "ssh" && check.status !== "ok")
    )
    const unreachable = before.find((check) => check.id === "ssh" && check.status === "manual")
    if (unreachable) {
      throw new Error(`[SshTarget] ${unreachable.detail}`)
    }

    if (serverFixes.length > 0) {
      const admin = context.admin ?? "root"
      const { identityFiles } = await resolveSshConfig(this.location)
      const key = await pickPublicKey({ key: context.key, identityFiles })
      context.write(
        `Setting up ${this.host} as ${admin}, authorizing ${key.source} for ${this.user}.`
      )
      await runAsAdmin(
        `${admin}@${this.host}`,
        admin === "root",
        renderAdminScript({ user: this.user, publicKey: key.text, admin })
      )
    }

    context.write(`Preparing ${context.name} as ${this.user}.`)
    await this.#connected((shell) =>
      shell.run(
        [
          `project="$HOME"/${shellQuote(`${context.name}/code/${context.projectPath}`)}`,
          'mkdir -p "$project"',
          'if [ -f "$project/.env" ]; then chmod 600 "$project/.env"; fi',
        ].join("\n")
      )
    )
  }

  readonly access: DeployAccess = {
    list: () => this.#connected(async (shell) => (await listKeys(shell)).map(withoutLine)),
    add: (key) => this.#connected((shell) => addKey(shell, key)).then(withoutLine),
    remove: (match) =>
      this.#connected(async (shell) => (await removeKeys(shell, match)).map(withoutLine)),
  }

  readonly ci: DeployCi = {
    create: (job, context) => this.#createCiKey(job, context.name),
  }

  /**
   * A key for one CI job, allowed to run commands and nothing else (no forwarding, no terminal),
   * with the server's host keys pinned so CI never trusts an address on first sight.
   */
  async #createCiKey(job: string, name: string): Promise<DeployCiCredential> {
    const ssh = await resolveSshConfig(this.location)
    if (ssh.proxyJump) {
      throw new Error(
        `[SshTarget] Your SSH config reaches ${this.host} through ${ssh.proxyJump}, and CI connects ` +
          "directly. Set `host` to an address CI can reach."
      )
    }
    // One comment per job and deployment: it is how a later run finds the keys it replaces.
    const comment = `sixb-ci:${name}@${job}`
    const pair = await generateCiKey(comment)
    const { key, hostKeys } = await this.#connected(async (shell) => ({
      hostKeys: await readHostKeys(shell),
      key: await addKey(shell, pair.publicKey, "restrict"),
    }))

    return {
      description: `${key.fingerprint} for ${this.location}, restricted to running commands`,
      secrets: {
        SIXB_DEPLOY_SSH_KEY: pair.privateKey,
        SIXB_DEPLOY_KNOWN_HOSTS: knownHostsLines(hostKeys, ssh.hostname, ssh.port).join("\n"),
      },
      install: renderCiInstall({ host: this.host, hostname: ssh.hostname, port: ssh.port }),
      retireOthers: () =>
        this.#connected(async (shell) =>
          (
            await removeKeysWhere(
              shell,
              (other) => other.comment === comment && other.fingerprint !== key.fingerprint
            )
          ).map(withoutLine)
        ),
      revoke: () =>
        this.#connected(async (shell) => {
          await removeKeysWhere(shell, (other) => other.fingerprint === key.fingerprint)
        }),
    }
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

/** What a failed connection means for a deploy, and whether setup can fix it. */
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
      remedy: `Run \`sixb deploy setup --admin <login>\` with a login that has sudo: it creates the deploy user and authorizes your key. Or have someone with access run \`sixb deploy access add\` with your key.`,
    }
  }
  return {
    id: "ssh",
    label: "SSH",
    status: "manual",
    detail: message || `Cannot reach ${location}.`,
  }
}

function withoutLine({ type, fingerprint, comment, restricted }: DeployAccessKey): DeployAccessKey {
  return { type, fingerprint, comment, restricted }
}

/**
 * Runs the setup script as the admin login with the terminal attached, so sudo can ask for its
 * password and the person running setup sees each step.
 */
async function runAsAdmin(destination: string, root: boolean, script: string): Promise<void> {
  const command = `${root ? "" : "sudo "}bash -c ${shellQuote(script)}`
  // LogLevel=ERROR drops the "Connection closed" line a terminal session ends with, not errors.
  const ssh = ["ssh", "-tt", "-o", "ConnectTimeout=15", "-o", "LogLevel=ERROR"]
  const child = Bun.spawn([...ssh, destination, command], {
    stdio: ["inherit", "inherit", "inherit"],
  })
  const exitCode = await child.exited
  if (exitCode !== 0) {
    throw new Error(
      `[SshTarget] Setting up the server as ${destination} failed (exit code ${exitCode}).`
    )
  }
}
