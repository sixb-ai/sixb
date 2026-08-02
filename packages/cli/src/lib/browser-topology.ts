import type { SixbBrowserOrigin } from "@sixb/server"
import { configuredOrigin } from "./public-origin"

/**
 * The process resolving the topology. One answer settles what used to be four options: whether
 * local defaults apply, which browser surfaces the process has to account for, and which one it
 * serves itself.
 */
export type BrowserRole = "dev" | "api" | "atlas" | "app"

/** The two surfaces a browser loads, and the audience each maps to. */
export type BrowserSurface = "atlas" | "app"

interface BrowserBindOptions {
  readonly host?: string
  readonly apiHost?: string
  readonly port?: string
  readonly appPort?: string
  readonly apiPort?: string
  readonly apiPublicOrigin?: string
  readonly atlasPublicOrigin?: string
  readonly appPublicOrigin?: string
}

export type BrowserTopologyOptions = BrowserBindOptions &
  (
    | {
        /**
         * Hosts the API, so its allowlist has to name every surface the project actually
         * serves — including the custom app, which exists only when the project has one.
         */
        readonly role: "dev" | "api"
        readonly hasCustomApp: boolean
      }
    | { readonly role: BrowserSurface }
  )

export interface BrowserTopology {
  readonly host: string
  readonly apiHost: string
  readonly atlasPort: number
  readonly appPort: number
  readonly apiPort: number
  readonly apiPublicOrigin: string
  readonly atlasPublicOrigin: string | null
  readonly appPublicOrigin: string | null
  readonly allowedBrowserOrigins: readonly SixbBrowserOrigin[]
  /** The surface this process serves itself, or `null` when it serves none. */
  readonly serves: BrowserSurface | null
}

/** A topology resolved by a role that serves a surface, so {@link servedUrl} always has one. */
export interface ServingBrowserTopology extends BrowserTopology {
  readonly serves: BrowserSurface
}

interface BrowserHosts {
  readonly host: string
  readonly apiHost: string
}

interface BrowserPorts {
  readonly atlasPort: number
  readonly appPort: number
  readonly apiPort: number
}

interface BrowserPublicOrigins {
  readonly apiPublicOrigin: string
  readonly atlasPublicOrigin: string | null
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
const DEFAULT_ATLAS_PORT = 3000
const DEFAULT_APP_PORT_OFFSET = 1
const DEFAULT_API_PORT_OFFSET = 2

export function resolveBrowserTopology(
  options: BrowserBindOptions & { readonly role: BrowserSurface }
): ServingBrowserTopology
export function resolveBrowserTopology(options: BrowserTopologyOptions): BrowserTopology
export function resolveBrowserTopology(options: BrowserTopologyOptions): BrowserTopology {
  const hosts = resolveBrowserHosts(options)
  const ports = resolveBrowserPorts(options)
  const origins = resolveBrowserPublicOrigins(options, ports)

  return {
    ...hosts,
    ...ports,
    ...origins,
    allowedBrowserOrigins: createAllowedBrowserOrigins(origins),
    serves: servedSurface(options.role),
  }
}

/** The surface a role serves itself. For the two roles that serve one, it is the role. */
function servedSurface(role: BrowserRole): BrowserSurface | null {
  return role === "atlas" || role === "app" ? role : null
}

/** The surfaces a role's topology has to resolve an origin for. */
function surfacesOf(options: BrowserTopologyOptions): Record<BrowserSurface, boolean> {
  switch (options.role) {
    case "dev":
    case "api":
      return { atlas: true, app: options.hasCustomApp }
    case "atlas":
      return { atlas: true, app: false }
    case "app":
      return { atlas: false, app: true }
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

function resolveBrowserPorts(options: BrowserTopologyOptions): BrowserPorts {
  const atlasPort = parsePort(options.port, "port", DEFAULT_ATLAS_PORT)
  const appPort = parsePort(options.appPort, "app-port", atlasPort + DEFAULT_APP_PORT_OFFSET)
  const apiPort = parsePort(options.apiPort, "api-port", atlasPort + DEFAULT_API_PORT_OFFSET)

  return {
    atlasPort,
    appPort,
    apiPort,
  }
}

function resolveBrowserPublicOrigins(
  options: BrowserTopologyOptions,
  ports: BrowserPorts
): BrowserPublicOrigins {
  const surfaces = surfacesOf(options)

  // Every browser surface sends its requests here, so this one is never inferred in production.
  const apiPublicOrigin =
    configuredOrigin(options.apiPublicOrigin, "SIXB_API_PUBLIC_ORIGIN", "API public origin") ??
    localOrigin(options.role, ports.apiPort) ??
    refusePublicOrigin("SIXB_API_PUBLIC_ORIGIN")

  const atlasPublicOrigin = surfaces.atlas
    ? resolveSurfaceOrigin(options, "atlas", {
        value: options.atlasPublicOrigin,
        envName: "SIXB_ATLAS_PUBLIC_ORIGIN",
        label: "Atlas public origin",
        port: ports.atlasPort,
      })
    : null
  const appPublicOrigin = surfaces.app
    ? resolveSurfaceOrigin(options, "app", {
        value: options.appPublicOrigin,
        envName: "SIXB_APP_PUBLIC_ORIGIN",
        label: "custom app public origin",
        port: ports.appPort,
      })
    : null

  return {
    apiPublicOrigin,
    atlasPublicOrigin,
    appPublicOrigin,
  }
}

/**
 * A browser surface's own public origin. Required wherever it feeds the API's CORS allowlist, and
 * optional on the role that serves the surface, which only prints it — refusing to start over a
 * label is a startup an operator has to debug for nothing.
 */
function resolveSurfaceOrigin(
  options: BrowserTopologyOptions,
  surface: BrowserSurface,
  input: {
    readonly value: string | undefined
    readonly envName: string
    readonly label: string
    readonly port: number
  }
): string | null {
  const configured = configuredOrigin(input.value, input.envName, input.label)
  if (configured) return configured

  const local = localOrigin(options.role, input.port)
  if (local) return local

  return options.role === surface ? null : refusePublicOrigin(input.envName)
}

function createAllowedBrowserOrigins(origins: BrowserPublicOrigins): readonly SixbBrowserOrigin[] {
  const allowedOrigins: SixbBrowserOrigin[] = []

  if (origins.atlasPublicOrigin) {
    allowedOrigins.push({ origin: origins.atlasPublicOrigin, audience: "atlas" })
  }

  if (origins.appPublicOrigin) {
    allowedOrigins.push({ origin: origins.appPublicOrigin, audience: "app" })
  }

  return allowedOrigins
}

/**
 * A bind address that is not an address anyone can open. The default production host is every
 * interface, so a panel that printed it verbatim answered "where do I go?" with `0.0.0.0`.
 */
const WILDCARD_BINDS = new Set(["0.0.0.0", "::", "[::]"])

/**
 * What a browser-serving role shows as its own address. The public origin when one is configured,
 * and otherwise the address it actually bound — which is all the process knows, and better than a
 * startup panel with no URL on it.
 */
export function servedUrl(topology: ServingBrowserTopology): string {
  const [origin, port] =
    topology.serves === "atlas"
      ? ([topology.atlasPublicOrigin, topology.atlasPort] as const)
      : ([topology.appPublicOrigin, topology.appPort] as const)

  return origin ?? `http://${displayHost(topology.host)}:${port}`
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

function parsePort(value: string | undefined, label: string, fallback: number): number {
  if (!value) {
    return fallback
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
