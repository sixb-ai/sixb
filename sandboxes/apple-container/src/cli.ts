import { type Stats, statSync } from "node:fs"
import { resolve } from "node:path"

export interface AppleContainerMount {
  /** Host directory to bind into the sandbox. Relative paths resolve at factory construction. */
  readonly hostPath: string
  /** Absolute destination path inside the container. */
  readonly containerPath: string
  /** Mount the host directory read-only. */
  readonly readOnly?: boolean
}

export interface NormalizedAppleContainerMount {
  readonly hostPath: string
  readonly containerPath: string
  readonly readOnly: boolean
}

export interface AppleContainerCliConfig {
  /** Resolved Apple Container CLI binary name or absolute path. */
  readonly bin: string
  /** For agent use, the image must include the worker's CLI runtime and shell utilities. */
  readonly image: string
  readonly cpus?: string
  readonly memory?: string
  readonly platform?: string
  readonly arch?: string
  readonly os?: string
  readonly rosetta?: boolean
  readonly readOnlyRootfs?: boolean
  readonly mounts: readonly NormalizedAppleContainerMount[]
  readonly ports: readonly number[]
  /** DNS servers passed to `container create --dns`. */
  readonly dns: readonly string[]
  /** Extra `container create` args passed before the image name. */
  readonly createArgs: readonly string[]
  readonly stopTimeoutSeconds?: number
}

export function buildNetworkCreateArgv(bin: string, name: string): string[] {
  return [bin, "network", "create", "--internal", name]
}

export function buildNetworkDeleteArgv(bin: string, name: string): string[] {
  return [bin, "network", "delete", name]
}

export function buildCreateArgv(
  config: AppleContainerCliConfig,
  params: {
    readonly id: string
    readonly workingDirectory: string
    readonly env: Readonly<Record<string, string>>
    readonly networkArgs: readonly string[]
  }
): string[] {
  return [
    config.bin,
    "create",
    "--name",
    params.id,
    ...buildEnvArgs(params.env),
    ...buildDnsArgs(config.dns),
    ...params.networkArgs,
    ...buildPortArgs(config.ports),
    ...buildResourceArgs(config),
    ...buildMountArgs(config.mounts),
    ...config.createArgs,
    config.image,
    "/bin/sh",
    "-lc",
    buildKeepAliveCommand(params.workingDirectory),
  ]
}

export function buildStartArgv(config: AppleContainerCliConfig, id: string): string[] {
  return [config.bin, "start", id]
}

export function buildExecArgv(
  config: AppleContainerCliConfig,
  params: {
    readonly id: string
    readonly cwd: string
    readonly command: string
    readonly args: readonly string[]
    readonly env: Readonly<Record<string, string>>
    readonly interactive?: boolean
  }
): string[] {
  return [
    config.bin,
    "exec",
    ...(params.interactive ? ["--interactive"] : []),
    ...buildEnvArgs(params.env),
    "--workdir",
    params.cwd,
    params.id,
    params.command,
    ...params.args,
  ]
}

export function buildStopArgv(config: AppleContainerCliConfig, id: string): string[] {
  return [
    config.bin,
    "stop",
    ...(config.stopTimeoutSeconds !== undefined
      ? ["--time", String(config.stopTimeoutSeconds)]
      : []),
    id,
  ]
}

export function buildDeleteArgv(config: AppleContainerCliConfig, id: string): string[] {
  return [config.bin, "delete", "--force", id]
}

export function normalizePorts(ports: readonly number[]): number[] {
  return Array.from(new Set(ports)).map((port) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new RangeError(`[Sandbox] invalid Apple Container port: ${port}`)
    }
    return port
  })
}

export function normalizeDnsServers(dns: readonly string[]): string[] {
  return Array.from(new Set(dns)).map((server) => {
    if (typeof server !== "string" || server.length === 0 || server.trim() !== server) {
      throw new TypeError(`[Sandbox] invalid Apple Container DNS server: ${String(server)}`)
    }
    return server
  })
}

export function normalizeMounts(
  mounts: readonly AppleContainerMount[]
): NormalizedAppleContainerMount[] {
  return mounts.map((mount) => {
    assertNonEmptyString(mount.hostPath, "Apple Container mount hostPath")
    assertNonEmptyString(mount.containerPath, "Apple Container mount containerPath")
    if (!mount.containerPath.startsWith("/")) {
      throw new TypeError(
        `[Sandbox] Apple Container mount containerPath must be absolute: ${mount.containerPath}`
      )
    }
    if (hasMountDelimiter(mount.hostPath) || hasMountDelimiter(mount.containerPath)) {
      throw new TypeError("[Sandbox] Apple Container mount paths must not contain ',' or '='")
    }

    const hostPath = resolve(mount.hostPath)
    const stat = statForMount(hostPath)
    if (!stat.isDirectory()) {
      throw new TypeError(
        `[Sandbox] Apple Container mount hostPath must be a directory: ${hostPath}`
      )
    }

    return {
      hostPath,
      containerPath: mount.containerPath,
      readOnly: mount.readOnly ?? false,
    }
  })
}

function buildEnvArgs(env: Readonly<Record<string, string>>): string[] {
  return Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`])
}

function buildDnsArgs(dns: readonly string[]): string[] {
  return dns.flatMap((server) => ["--dns", server])
}

function buildPortArgs(ports: readonly number[]): string[] {
  return ports.flatMap((port) => ["--publish", `127.0.0.1:${port}:${port}/tcp`])
}

function buildResourceArgs(config: AppleContainerCliConfig): string[] {
  return [
    ...(config.cpus !== undefined ? ["--cpus", config.cpus] : []),
    ...(config.memory !== undefined ? ["--memory", config.memory] : []),
    ...(config.platform !== undefined ? ["--platform", config.platform] : []),
    ...(config.arch !== undefined ? ["--arch", config.arch] : []),
    ...(config.os !== undefined ? ["--os", config.os] : []),
    ...(config.rosetta === true ? ["--rosetta"] : []),
    ...(config.readOnlyRootfs === true ? ["--read-only"] : []),
  ]
}

function buildMountArgs(mounts: readonly NormalizedAppleContainerMount[]): string[] {
  return mounts.flatMap((mount) => [
    "--mount",
    [
      "type=bind",
      `source=${mount.hostPath}`,
      `target=${mount.containerPath}`,
      ...(mount.readOnly ? ["readonly"] : []),
    ].join(","),
  ])
}

function buildKeepAliveCommand(workingDirectory: string): string {
  return [
    `mkdir -p -- ${shellQuote(workingDirectory)}`,
    "trap 'exit 0' TERM INT",
    "while :; do sleep 2147483647 & wait $!; done",
  ].join(" && ")
}

function assertNonEmptyString(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`[Sandbox] ${name} must be a non-empty string`)
  }
}

function hasMountDelimiter(path: string): boolean {
  return path.includes(",") || path.includes("=")
}

function statForMount(hostPath: string): Stats {
  try {
    return statSync(hostPath)
  } catch {
    throw new TypeError(`[Sandbox] Apple Container mount hostPath does not exist: ${hostPath}`)
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
