import { configuredOrigin } from "./public-origin"

/**
 * The process resolving the topology. One answer settles what used to be four options: whether
 * local defaults apply, whether the app's origin is required, and whether the process serves the
 * app itself.
 */
export type BrowserRole = "dev" | "api" | "app"

export interface BrowserTopologyOptions {
  readonly role: BrowserRole
  readonly host?: string
  /** `--port`: the port this role binds. See {@link resolveBrowserPorts}. */
  readonly port?: string
  /** `--api-host` and `--api-port`, which only the two roles that bind the API accept. */
  readonly apiHost?: string
  readonly apiPort?: string
  readonly apiPublicOrigin?: string
  readonly appPublicOrigin?: string
}

export interface BrowserTopology {
  readonly host: string
  readonly apiHost: string
  readonly appPort: number
  readonly apiPort: number
  readonly apiPublicOrigin: string
  /** `null` outside `sixb dev` when nobody said where the app is published. */
  readonly appPublicOrigin: string | null
  readonly allowedBrowserOrigins: readonly string[]
}

interface BrowserHosts {
  readonly host: string
  readonly apiHost: string
}

interface BrowserPorts {
  readonly appPort: number
  readonly apiPort: number
}

interface BrowserPublicOrigins {
  readonly apiPublicOrigin: string
  readonly appPublicOrigin: string | null
}

/**
 * A production role sits behind a load balancer and has to accept its traffic. A dev
 * server does not: binding every interface put the project's data — and an API that is
 * usually running with auth disabled — on the local network, which on a café or office
 * network means anyone on it. `--host 0.0.0.0` opts back in.
 */
const DEFAULT_PRODUCTION_HOST = "0.0.0.0"
const DEFAULT_DEVELOPMENT_HOST = "127.0.0.1"
const DEFAULT_APP_PORT = 3000
const DEFAULT_API_PORT_OFFSET = 1

export function resolveBrowserTopology(options: BrowserTopologyOptions): BrowserTopology {
  const hosts = resolveBrowserHosts(options)
  const ports = resolveBrowserPorts(options)
  const origins = resolveBrowserPublicOrigins(options, ports)

  return {
    ...hosts,
    ...ports,
    ...origins,
    allowedBrowserOrigins: createAllowedBrowserOrigins(origins),
  }
}

function resolveBrowserHosts(options: BrowserTopologyOptions): BrowserHosts {
  const host =
    options.host ?? (options.role === "dev" ? DEFAULT_DEVELOPMENT_HOST : DEFAULT_PRODUCTION_HOST)
  return {
    host,
    apiHost: options.apiHost ?? host,
  }
}

/**
 * `--port` is the port the role binds. `sixb dev` binds the app and the API, so there it moves
 * both and the API keeps its offset from the app. Every other role binds exactly one, and `--port`
 * moves only that one — which is why `sixb api --port 4000` listens on 4000 and not one past it.
 * The port a role does not bind keeps its default and is read by nobody.
 */
function resolveBrowserPorts(options: BrowserTopologyOptions): BrowserPorts {
  const requested = parsePort(options.port, "port")
  const base = options.role === "dev" ? (requested ?? DEFAULT_APP_PORT) : DEFAULT_APP_PORT
  const bound = options.role === "dev" ? undefined : requested

  return {
    appPort: (options.role === "app" ? bound : undefined) ?? base,
    apiPort:
      parsePort(options.apiPort, "api-port") ??
      (options.role === "api" ? bound : undefined) ??
      base + DEFAULT_API_PORT_OFFSET,
  }
}

function resolveBrowserPublicOrigins(
  options: BrowserTopologyOptions,
  ports: BrowserPorts
): BrowserPublicOrigins {
  // The app sends its requests here, so this one is never inferred in production.
  const apiPublicOrigin =
    configuredOrigin(options.apiPublicOrigin, "SIXB_API_PUBLIC_ORIGIN", "API public origin") ??
    localOrigin(options.role, ports.apiPort) ??
    refusePublicOrigin("SIXB_API_PUBLIC_ORIGIN")

  // Never guessed either: on the API it is the whole CORS allowlist. Without one the API admits
  // no browser origin, which is right for a deploy with no app (`services: { app: false }`), and
  // the app role only prints its own origin.
  const appPublicOrigin =
    configuredOrigin(options.appPublicOrigin, "SIXB_APP_PUBLIC_ORIGIN", "app public origin") ??
    localOrigin(options.role, ports.appPort)

  return { apiPublicOrigin, appPublicOrigin }
}

function createAllowedBrowserOrigins(origins: BrowserPublicOrigins): readonly string[] {
  return origins.appPublicOrigin ? [origins.appPublicOrigin] : []
}

/**
 * A bind address that is not an address anyone can open. The default production host is every
 * interface, so a panel that printed it verbatim answered "where do I go?" with `0.0.0.0`.
 */
const WILDCARD_BINDS = new Set(["0.0.0.0", "::", "[::]"])

/**
 * What the app role shows as its own address. The public origin when one is configured,
 * and otherwise the address it actually bound — which is all the process knows, and better than a
 * startup panel with no URL on it.
 */
export function servedUrl(topology: BrowserTopology): string {
  return topology.appPublicOrigin ?? `http://${displayHost(topology.host)}:${topology.appPort}`
}

function displayHost(host: string): string {
  return WILDCARD_BINDS.has(host) ? "localhost" : host
}

export function apiUrl(topology: BrowserTopology): string {
  return new URL("/api", topology.apiPublicOrigin).toString().replace(/\/$/, "")
}

export function apiDocsUrl(topology: BrowserTopology): string {
  return new URL("/docs", topology.apiPublicOrigin).toString()
}

export function apiEventsUrl(topology: BrowserTopology): string {
  const url = new URL("/ws/events", topology.apiPublicOrigin)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}

/** The local default, or `null` outside `sixb dev`, where an origin behind a proxy is a guess. */
function localOrigin(role: BrowserRole, port: number): string | null {
  return role === "dev" ? `http://localhost:${port}` : null
}

function refusePublicOrigin(envName: string): never {
  throw new Error(
    `[SixbCLI] Production serving requires ${envName} or --${toKebabCase(envName.replace(/^SIXB_/, "").toLowerCase())}.`
  )
}

/** The port a flag set, or `undefined` when it did not. `label` names the flag in the error. */
function parsePort(value: string | undefined, label: string): number | undefined {
  if (!value) {
    return undefined
  }

  const port = Number.parseInt(value, 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || String(port) !== value.trim()) {
    throw new Error(`[SixbCLI] --${label} must be a valid TCP port.`)
  }

  return port
}

function toKebabCase(value: string): string {
  return value.replaceAll("_", "-")
}
